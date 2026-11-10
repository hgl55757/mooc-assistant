// ==UserScript==
// @name         中国大学MOOC 学习测验助手
// @namespace    mooc-learning-quiz-merged
// @version      1.0.8
// @description  自动学习视频与文档，跳过讨论；视频弹题自动处理并继续学习；自选题模式只做选择、判断和填空。
// @author       based on weiy02/ChinaMOOC-Auto and icourse-auto
// @license      MIT
// @match        *://www.icourse163.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

// 基于 weiy02/ChinaMOOC-Auto 与用户提供的 icourse-auto；保留 MIT 许可。
(function () {
    'use strict';
    var CONFIG = {
        DELAY_AFTER_CLICK: 300,
        CANCEL_POLL_INTERVAL: 60,
        LEARN_DOC_PAGE_MS: 1000,        // 文档每页停留 1 秒（用户要求）
        LEARN_NAV_WAIT: 5000,           // 切换内容后的加载等待上限
        LEARN_QUIZ_RESUME_WAIT: 8000,   // 提交视频弹题后，等待视频自动恢复播放的最长时间
        LEARN_CONTENT_READY_WAIT: 15000, // 内容加载就绪的最大等待时间（修复“没加载完就跳转”）
        LEARN_IDLE_POLL: 600,           // 视频监控轮询间隔（毫秒）
        LEARN_MAX_PAGE_FLIPS: 600,      // 单个文档最多翻多少页（保险上限）
    };

    var PAGE_CONFIG = {
        examUrl: /examObject|examIndex|examPaper|\/learn\/exam/i,
        quizUrl: /quizObject|quizIndex|testObject|\/learn\/quiz|\/learn\/test|homeworkObject|\/learn\/homework/i,
    };

    var taskState = { running: false, cancelled: false, stopReason: "", outcomeRecorded: false, lastStatus: "" };

    function makeCancelError(reason) {
        var e = new Error(reason || taskState.stopReason || '任务取消：未记录停止按钮点击，可能是页面状态改变');
        e.__cancelled = true;
        e.stopReason = e.message;
        return e;
    }

    function sleep(ms) {
        return new Promise(function (resolve, reject) {
            var start = Date.now();
            function tick() {
                if (taskState.cancelled) { reject(makeCancelError()); return; }
                if (Date.now() - start >= ms) { resolve(); return; }
                setTimeout(tick, CONFIG.CANCEL_POLL_INTERVAL);
            }
            tick();
        });
    }
    function sleepWhile(ms, early) {
        return new Promise(function (resolve, reject) {
            var start = Date.now();
            function tick() {
                if (taskState.cancelled) { reject(makeCancelError()); return; }
                if (Date.now() - start >= ms || (typeof early === 'function' && early())) { resolve(); return; }
                setTimeout(tick, 250);
            }
            tick();
        });
    }

    async function waitFor(fn, timeoutMs, intervalMs) {
        var start = Date.now();
        var iv = intervalMs || 200;
        while (Date.now() - start < timeoutMs) {
            if (taskState.cancelled) throw makeCancelError();
            try { if (fn()) return true; } catch (e) { /* ignore */ }
            await sleep(iv);
        }
        return false;
    }
    function isVisible(el) {
        if (!el) return false;
        var s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
        if (el.offsetParent === null && s.position !== 'fixed') return false;
        return true;
    }

    function realClick(el) {
        if (!el) return;
        var types = ['mousedown', 'mouseup', 'click'];
        for (var i = 0; i < types.length; i++) {
            el.dispatchEvent(new MouseEvent(types[i], { bubbles: true, cancelable: true }));
        }
    }
    var RUN_EVENTS_KEY = 'mooc.merged.run.events.v2';

    function readRunEvents() {
        try { return JSON.parse(sessionStorage.getItem(RUN_EVENTS_KEY) || '[]'); }
        catch (e) { return []; }
    }

    function recordRunEvent(type, message) {
        var events = readRunEvents();
        if (!Array.isArray(events)) events = [];
        events.push({ time: new Date().toISOString(), type: type, message: String(message) });
        try { sessionStorage.setItem(RUN_EVENTS_KEY, JSON.stringify(events.slice(-40))); } catch (e) {}
        logDebug('运行记录/' + type, message);
    }

    function finishRun(type, reason) {
        if (taskState.outcomeRecorded) return;
        taskState.outcomeRecorded = true;
        taskState.stopReason = reason;
        recordRunEvent(type, reason);
        learnClearState(); setFloatVisible(false);
        updateStatus((type === 'complete' ? '✅ ' : '⏹ ') + reason);
    }

    function requestStop(event) {
        if (!taskState.running || taskState.cancelled) return;
        var reason = event && event.isTrusted
            ? '手动停止：点击了停止按钮'
            : '停止按钮被程序触发（非真实点击）';
        taskState.cancelled = true;
        finishRun('stop', reason);
    }

    function showRunHistory() {
        var events = readRunEvents();
        if (!Array.isArray(events)) events = [];
        showTextOverlay('运行记录（保留最近 40 条）', events.map(function (e) {
            return e.time + ' [' + e.type + '] ' + e.message;
        }).join('\n') || '暂无运行记录');
    }

    function initRunDiagnostics() {
        var events = readRunEvents();
        if (Array.isArray(events) && events.length) {
            events.slice(-5).forEach(function (e) { logDebug('历史运行/' + e.type, e.time + ' ' + e.message); });
            if (!learnLoadState()) updateStatus('上次记录：' + events[events.length - 1].message);
        }
        window.addEventListener('pagehide', function () {
            if (!taskState.running || taskState.cancelled) return;
            var video = findVideo();
            var position = video && Number.isFinite(video.currentTime) ? '，视频位置 ' + Math.floor(video.currentTime) + ' 秒' : '';
            recordRunEvent('pagehide', '页面离开或刷新' + position + '；如仍有学习计划，将在同课程内容页尝试续跑');
        });
        document.addEventListener('visibilitychange', function () {
            if (!taskState.running || taskState.cancelled) return;
            recordRunEvent('visibility', document.hidden ? '页面切到后台（未请求停止）' : '页面回到前台（未请求停止）');
        });
    }

    function readStore(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            console.warn('[MOOC助手] 读取本地存储失败', key, e);
            return fallback;
        }
    }

    function writeStore(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
            return true;
        } catch (e) {
            console.warn('[MOOC助手] 写入本地存储失败', key, e);
            return false;
        }
    }
    var COPY_UNLOCK = {
        STYLE_ID: 'mar-copy-unlock-style',
        KEY: 'mar.copyUnlock',
        EVENTS: ['copy', 'cut', 'paste', 'selectstart', 'contextmenu', 'dragstart'],
    };

    var copyUnlockBound = false;

    function copyUnlockCss() {
        return [
            'html, body, body * {',
            '  -webkit-user-select: text !important;',
            '  -moz-user-select: text !important;',
            '  -ms-user-select: text !important;',
            '  user-select: text !important;',
            '  -webkit-touch-callout: default !important;',
            '}',
            'img, a { -webkit-user-drag: auto !important; }',
        ].join('\n');
    }

    function copyUnlockHandler(e) {
        e.stopImmediatePropagation();
    }
    function copyUnlockKeydown(e) {
        var k = String(e.key || '').toLowerCase();
        if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'x' || k === 'a')) {
            e.stopImmediatePropagation();
        }
    }

    function isCopyUnlockOn() {
        return readStore(COPY_UNLOCK.KEY, false) === true;
    }

    function applyCopyUnlock(on) {
        var existing = document.getElementById(COPY_UNLOCK.STYLE_ID);
        if (on) {
            if (!existing) {
                var style = document.createElement('style');
                style.id = COPY_UNLOCK.STYLE_ID;
                style.textContent = copyUnlockCss();
                (document.head || document.documentElement).appendChild(style);
            }
            if (!copyUnlockBound) {
                for (var i = 0; i < COPY_UNLOCK.EVENTS.length; i++) {
                    window.addEventListener(COPY_UNLOCK.EVENTS[i], copyUnlockHandler, true);
                }
                window.addEventListener('keydown', copyUnlockKeydown, true);
                copyUnlockBound = true;
            }
        } else {
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            if (copyUnlockBound) {
                for (var j = 0; j < COPY_UNLOCK.EVENTS.length; j++) {
                    window.removeEventListener(COPY_UNLOCK.EVENTS[j], copyUnlockHandler, true);
                }
                window.removeEventListener('keydown', copyUnlockKeydown, true);
                copyUnlockBound = false;
            }
        }
        writeStore(COPY_UNLOCK.KEY, !!on);
    }

    function updateCopyUnlockButton() {
        var btn = document.getElementById('mar-copy-unlock');
        if (!btn) return;
        var on = isCopyUnlockOn();
        btn.textContent = '解除复制限制：' + (on ? '开' : '关');
        if (on) btn.classList.add('mar-on'); else btn.classList.remove('mar-on');
    }

    function toggleCopyUnlock() {
        var next = !isCopyUnlockOn();
        applyCopyUnlock(next);
        updateCopyUnlockButton();
        updateStatus(next
            ? '🔓 已解除复制限制：可选中、可右键、Ctrl/⌘+C 可用'
            : '🔒 已恢复页面原本的复制限制');
    }

    function cleanText(s) {
        return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
    }

    function collectCandidates(scope, selectors, limit) {
        var out = [], seen = [];
        for (var s = 0; s < selectors.length && out.length < limit; s++) {
            var found;
            try { found = scope.querySelectorAll(selectors[s]); } catch (e) { continue; }
            for (var i = 0; i < found.length && out.length < limit; i++) {
                if (seen.indexOf(found[i]) !== -1) continue;
                seen.push(found[i]);
                out.push(found[i]);
            }
        }
        return out;
    }

    async function dismissModal() {
        await sleep(500);
        var selectors = ['.u-dialog', '.m-dialog', '.u-popup', '.u-layer', '[class*="dialog"]', '[class*="modal"]'];
        for (var s = 0; s < selectors.length; s++) {
            var modals = document.querySelectorAll(selectors[s]);
            for (var i = 0; i < modals.length; i++) {
                if (!isVisible(modals[i])) continue;
                var btns = modals[i].querySelectorAll('button, a, .u-btn, .m-btn');
                for (var j = 0; j < btns.length; j++) {
                    var t = (btns[j].textContent || '').trim();
                    if (/^(确定|继续|知道了|关闭|好的)$/.test(t)) {
                        realClick(btns[j]);
                        await sleep(800);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function showTextOverlay(title, text, onSave) {
        var old = document.getElementById('mar-probe-overlay');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var overlay = document.createElement('div');
        overlay.id = 'mar-probe-overlay';
        overlay.innerHTML = [
            '<div id="mar-probe-head">',
            '  <span id="mar-probe-title"></span>',
            '  <span id="mar-probe-actions">',
            onSave ? '    <button id="mar-probe-save" class="mar-btn">保存</button>' : '',
            '    <button id="mar-probe-copy" class="mar-btn">复制</button>',
            '    <button id="mar-probe-close" class="mar-btn">关闭</button>',
            '  </span>',
            '</div>',
            '<textarea id="mar-probe-text" spellcheck="false"></textarea>'
        ].join('');
        document.body.appendChild(overlay);
        document.getElementById('mar-probe-title').textContent = title;

        var ta = document.getElementById('mar-probe-text');
        ta.value = text;
        ta.focus();
        ta.select();

        document.getElementById('mar-probe-close').addEventListener('click', function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        });
        document.getElementById('mar-probe-copy').addEventListener('click', function () {
            ta.focus();
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            updateStatus(ok ? '✅ 已复制到剪贴板' : '⚠️ 自动复制失败，请手动全选复制文本框内容');
        });
        if (onSave) {
            document.getElementById('mar-probe-save').addEventListener('click', function () {
                onSave(ta.value);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            });
        }
    }
    var statusEl = null;
    var debugLogs = [];
    var DEBUG_LOG_MAX = 500;      // 内存里最多保留多少条，超出丢最旧
    var DEBUG_LOG_SHOW = 120;     // 面板里最多展示多少条
    function logDebug(cat, msg) {
        var t = new Date();
        var ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + '.' + ('00' + t.getMilliseconds()).slice(-3);
        debugLogs.push({ t: ts, cat: cat, msg: String(msg || '') });
        if (debugLogs.length > DEBUG_LOG_MAX) debugLogs.splice(0, debugLogs.length - DEBUG_LOG_MAX);
        try { console.log('[MOOC:' + cat + ']', ts, msg); } catch (e) {}
        refreshLogBox();
    }
    function escHtml(s) {
        return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function refreshLogBox() {
        var box = document.getElementById('mar-log-box');
        if (!box || !box.parentElement.classList.contains('mar-active')) return;
        var frag = [];
        var start = Math.max(0, debugLogs.length - DEBUG_LOG_SHOW);
        for (var i = start; i < debugLogs.length; i++) {
            var l = debugLogs[i];
            frag.push('<div class="mar-log-line"><span class="mar-log-t">' + l.t + '</span>[<span class="mar-log-cat">' + l.cat + '</span>] ' + escHtml(l.msg) + '</div>');
        }
        box.innerHTML = frag.length ? frag.join('') : '<div class="mar-log-empty">（暂无日志）</div>';
        try { box.scrollTop = box.scrollHeight; } catch (e) {}
    }

    function clearDebugLogs() {
        debugLogs = [];
        refreshLogBox();
    }
    function copyDebugLogs() {
        var text = debugLogs.map(function (l) { return l.t + ' [' + l.cat + '] ' + l.msg; }).join('\n');
        if (!text) { updateStatus('暂无日志可复制'); return; }
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            updateStatus('✅ 已复制 ' + debugLogs.length + ' 条日志');
        } catch (e) {
            showTextOverlay('调试日志', text);
            updateStatus('已用浮层展示日志（复制失败）');
        }
    }

    function updateStatus(msg) {
        taskState.lastStatus = String(msg || "");
        if (statusEl) statusEl.textContent = msg;
        logDebug('status', msg);
    }
    function setButtonsRunning(isRunning) {
        var btns = document.querySelectorAll('#mooc-auto-review-panel .mar-btn');
        for (var i = 0; i < btns.length; i++) {
            var el = btns[i];
            if (el.id === 'mar-stop') continue;
            if (el.classList.contains('mar-toggle')) continue;
            if (el.id === 'mar-log-copy' || el.id === 'mar-log-clear' || el.id === 'mar-run-history') continue;
            el.disabled = isRunning;
        }
        var stop = document.getElementById('mar-stop');
        if (stop) {
            stop.style.display = isRunning ? 'flex' : 'none';
            stop.disabled = !isRunning;
        }
    }
    function injectStyles() {
        if (document.getElementById('mar-glass-styles')) return;
        var style = document.createElement('style');
        style.id = 'mar-glass-styles';
        style.textContent = String.raw`#mooc-auto-review-panel { position: fixed !important; top: 100px; right: 20px; z-index: 2147483647 !important; width: 252px; border-radius: 18px; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1c1c1e; user-select: none; background: rgba(252, 252, 254, 0.68); backdrop-filter: blur(32px) saturate(180%); -webkit-backdrop-filter: blur(32px) saturate(180%); border: 1px solid rgba(255, 255, 255, 0.75); box-shadow: 0 12px 32px -8px rgba(15, 20, 40, 0.18), 0 2px 8px -2px rgba(15, 20, 40, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 -1px 0 rgba(255, 255, 255, 0.35); }
#mar-header { display: flex; justify-content: space-between; align-items: center; padding: 11px 14px; cursor: move; font-size: 13px; font-weight: 600; letter-spacing: 0.01em; color: #1c1c1e; background: rgba(255, 255, 255, 0.22); border-bottom: 1px solid rgba(255, 255, 255, 0.55); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7); }
#mar-title { display: flex; align-items: center; gap: 7px; }
#mar-title .mar-dot { width: 7px; height: 7px; border-radius: 50%; background: #4a90e2; box-shadow: 0 0 0 2px rgba(74, 144, 226, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.6); }
#mar-minimize { cursor: pointer; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255, 255, 255, 0.55); border: 1px solid rgba(255, 255, 255, 0.8); font-size: 13px; line-height: 1; color: #3a3a3c; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 1px 2px rgba(0, 0, 0, 0.05); transition: background 0.18s ease, transform 0.18s ease; }
#mar-minimize:hover { background: rgba(255, 255, 255, 0.85); transform: scale(1.06); }
#mar-minimize:active { transform: scale(0.94); }
#mar-tabs { display: flex; gap: 3px; padding: 7px 9px 0; }
.mar-tab { position: relative; flex: 1; padding: 6px 4px; border: 1px solid transparent; border-radius: 9px; background: transparent; font-family: inherit; font-size: 12px; font-weight: 500; color: #7a7a80; cursor: pointer; transition: color 0.16s ease, background 0.16s ease; }
.mar-tab:hover:not(.mar-active) { color: #1c1c1e; background: rgba(255, 255, 255, 0.34); }
.mar-tab.mar-active { color: #1c1c1e; font-weight: 600; background: rgba(255, 255, 255, 0.62); border-color: rgba(255, 255, 255, 0.75); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 1px 2px rgba(15, 20, 40, 0.05); }
.mar-pane { display: none; flex-direction: column; gap: 7px; }
.mar-pane.mar-active { display: flex; }
#mar-body { padding: 10px 12px; }
#mar-foot { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 7px; }
.mar-btn { position: relative; display: flex; align-items: center; gap: 9px; padding: 9px 12px; border-radius: 11px; border: 1px solid rgba(255, 255, 255, 0.75); background: rgba(255, 255, 255, 0.42); color: #1c1c1e; font-family: inherit; font-size: 12.5px; font-weight: 500; text-align: left; cursor: pointer; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 2px rgba(15, 20, 40, 0.05); transition: background 0.18s ease, transform 0.14s ease, box-shadow 0.18s ease; }
.mar-btn::before { content: ""; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: #94a3b8; box-shadow: inset 0 1px 0 rgba(255,255,255,0.7); transition: transform 0.18s ease; }
#mar-one::before { background: #4a90e2; }
#mar-batch::before { background: #34a853; }
#mar-auto::before { background: #f5a623; }
#mar-fix::before { background: #8b5cf6; }
#mar-discuss-preview::before { background: #0ea5e9; }
#mar-discuss-reply::before { background: #22c55e; }
#mar-learn-start::before { background: #f97316; }
#mar-learn-probe::before { background: #14b8a6; }
#mar-stop::before { background: #e53e3e; }
.mar-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.72); transform: translateY(-1px); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 1), 0 4px 10px -2px rgba(15, 20, 40, 0.12); }
.mar-btn:hover:not(:disabled)::before { transform: scale(1.15); }
.mar-btn:active:not(:disabled) { transform: translateY(0); background: rgba(255, 255, 255, 0.5); box-shadow: inset 0 1px 3px rgba(15, 20, 40, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.6); }
.mar-btn:disabled { opacity: 0.42; cursor: not-allowed; filter: saturate(0.4); }
#mar-fix:not(:disabled) { color: #6d28d9; background: rgba(243, 236, 255, 0.55); border-color: rgba(200, 180, 255, 0.8); }
#mar-fix:hover:not(:disabled) { background: rgba(238, 226, 255, 0.85); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 1), 0 4px 12px -2px rgba(109, 40, 217, 0.22); }
#mar-stop:not(:disabled) { color: #b42318; background: rgba(255, 236, 236, 0.6); border-color: rgba(255, 200, 200, 0.8); }
#mar-stop:hover:not(:disabled) { background: rgba(255, 224, 224, 0.85); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 1), 0 4px 12px -2px rgba(180, 35, 24, 0.22); }
#mar-stop { display: none; }
#mar-status { padding: 9px 11px; border-radius: 10px; background: rgba(255, 255, 255, 0.3); border: 1px solid rgba(255, 255, 255, 0.55); box-shadow: inset 0 1px 2px rgba(15, 20, 40, 0.04), inset 0 -1px 0 rgba(255, 255, 255, 0.6); font-size: 11.5px; line-height: 1.5; color: #3a3a3c; min-height: 16px; word-break: break-all; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
#mar-copy-unlock::before { background: #64748b; }
.mar-log-box { height: 150px; overflow-y: auto; padding: 6px 8px; border-radius: 10px; background: rgba(15, 20, 40, 0.92); border: 1px solid rgba(255, 255, 255, 0.18); font-family: Menlo, Consolas, "SF Mono", monospace; font-size: 10.5px; line-height: 1.45; color: #d6dbe6; white-space: pre-wrap; word-break: break-all; }
.mar-log-line { margin: 1px 0; }
.mar-log-t { color: #8b93a7; margin-right: 4px; }
.mar-log-cat { color: #7dd3fc; font-weight: 600; }
.mar-log-empty { color: #8b93a7; padding: 8px 2px; }
#mar-copy-unlock.mar-on::before { background: #22c55e; }
#mar-copy-unlock.mar-on:not(:disabled) { color: #15803d; background: rgba(226, 252, 235, 0.6); border-color: rgba(160, 230, 190, 0.85); }
#mar-copy-unlock.mar-on:hover:not(:disabled) { background: rgba(214, 250, 226, 0.88); }
.mar-field { display: flex; flex-direction: column; gap: 6px; padding: 9px 11px; border-radius: 11px; background: rgba(255, 255, 255, 0.3); border: 1px solid rgba(255, 255, 255, 0.55); box-shadow: inset 0 1px 2px rgba(15, 20, 40, 0.04); }
.mar-label { font-size: 11.5px; font-weight: 600; color: #3a3a3c; }
.mar-hint { font-size: 10.5px; line-height: 1.45; color: #7a7a80; }
.mar-seg { display: flex; gap: 3px; padding: 3px; border-radius: 9px; background: rgba(255, 255, 255, 0.3); border: 1px solid rgba(255, 255, 255, 0.6); }
.mar-seg-btn { flex: 1; padding: 6px 4px; border: 1px solid transparent; border-radius: 7px; background: transparent; font-family: inherit; font-size: 11.5px; font-weight: 500; color: #7a7a80; cursor: pointer; transition: color 0.16s ease, background 0.16s ease; }
.mar-seg-btn:hover:not(.mar-active) { color: #1c1c1e; background: rgba(255, 255, 255, 0.4); }
.mar-seg-btn.mar-active { color: #1c1c1e; font-weight: 600; background: rgba(255, 255, 255, 0.75); border-color: rgba(255, 255, 255, 0.85); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 1px 2px rgba(15, 20, 40, 0.06); }
#mar-probe-overlay { position: fixed !important; top: 5vh; left: 50%; transform: translateX(-50%); width: min(900px, 92vw); height: 90vh; z-index: 2147483647 !important; display: flex; flex-direction: column; border-radius: 14px; overflow: hidden; background: rgba(28, 28, 32, 0.97); border: 1px solid rgba(255, 255, 255, 0.16); box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.6); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; user-select: text; }
#mar-probe-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 14px; background: rgba(255, 255, 255, 0.06); border-bottom: 1px solid rgba(255, 255, 255, 0.12); color: #f2f2f7; font-size: 13px; font-weight: 600; }
#mar-probe-actions { display: flex; gap: 8px; }
#mar-probe-actions .mar-btn { padding: 5px 12px; font-size: 12px; width: auto; color: #f2f2f7; background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.2); }
#mar-probe-actions .mar-btn::before { display: none; }
#mar-probe-actions .mar-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.22); }
#mar-probe-text { flex: 1; width: 100%; resize: none; border: 0; outline: none; padding: 12px 14px; margin: 0; background: transparent; color: #d7d7dc; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; white-space: pre; overflow: auto; user-select: text; }`;
        document.head.appendChild(style);
    }
    function switchTab(name) {
        if (!document.querySelector('#mooc-auto-review-panel .mar-pane[data-pane="' + name + '"]')) return;
        var tabs = document.querySelectorAll('#mooc-auto-review-panel .mar-tab');
        for (var i = 0; i < tabs.length; i++) {
            var on = tabs[i].getAttribute('data-tab') === name;
            if (on) tabs[i].classList.add('mar-active');
            else tabs[i].classList.remove('mar-active');
        }
        var panes = document.querySelectorAll('#mooc-auto-review-panel .mar-pane');
        for (var j = 0; j < panes.length; j++) {
            var p = panes[j];
            if (p.getAttribute('data-pane') === name) p.classList.add('mar-active');
            else p.classList.remove('mar-active');
        }
    }

    function hasVisibleQuestionBlocks() {
        var els = document.querySelectorAll(
            '.u-questionItem, .m-choiceQuestion, .m-subjectiveQuestion, .m-fillblankQuestion, .j-questionItem, ' +
            '[class*="questionItem"], [class*="question-item"], [class*="choiceQuestion"], [class*="fillblankQuestion"], ' +
            '[class*="fillblank"], [class*="judgeQuestion"], [class*="objectiveQuestion"], [class*="testItem"]'
        );
        for (var i = 0; i < els.length; i++) {
            if (isVisible(els[i])) return true;
        }
        return false;
    }
    function looksLikeChapterHeading(t) {
        if (!t || t.length < 2 || t.length > 30) return false;
        if (/章|讲|篇|专题|Module|Chapter|Part/i.test(t)) return true;
        if (/周/.test(t) && /第\s*[一二三四五六七八九十\d]+\s*周/.test(t)) return true;
        if (/单元(?!测验|测试|作业|检测|练习)/.test(t)) return true;
        if (/^\d{1,2}\s*[^\d.、．\-－]/.test(t)) return true; // “1 总论”“2 会计科目”
        return false;
    }
    function chapterTitleOfLink(link) {
        var node = link && link.parentElement;
        var depth = 0;
        while (node && depth < 10) {
            var heads = node.querySelectorAll(
                ':scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, ' +
                ':scope > [class*="chapter"], :scope > [class*="catalog-title"], :scope > [class*="catalogTitle"], ' +
                ':scope > [class*="unit-title"], :scope > [class*="unitTitle"]'
            );
            for (var i = 0; i < heads.length; i++) {
                var t = cleanText(heads[i].textContent);
                if (looksLikeChapterHeading(t)) return t;
            }
            node = node.parentElement;
            depth++;
        }
        return null;
    }
    function activeTabIsVideo() {
        var tab = currentContentTab();
        return !!(tab && tab.querySelector('[data-lesson-type-icon="video"]'));
    }
    function findVideo() {
        var videos = document.querySelectorAll('video');
        for (var i = 0; i < videos.length; i++) if (isVisible(videos[i])) return videos[i];
        // 弹题/自定义播放器可能隐藏 video 画面，但媒体元素仍是当前视频。
        if (activeTabIsVideo()) {
            for (var j = 0; j < videos.length; j++) {
                var rect = videos[j].getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return videos[j];
            }
        }
        return null;
    }
    function findPlayButtons() {
        var out = [], els = document.querySelectorAll('button, a, [role="button"], span, div');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!isVisible(el)) continue;
            var cls = String(el.className || '');
            var label = el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('title') || '') : '';
            if (!/\b(play|start)\b/i.test(cls) && !/play|start/i.test(label) && !/播放|开始/.test(cleanText((el.textContent || '').slice(0, 12)))) continue;
            if (el.clientWidth > 400 || el.clientHeight > 400) continue;
            out.push(el);
        }
        return out;
    }

    async function playVideo(video) {
        if (!video) return;
        applyVideoRate(video);
        var p = null;
        try { p = video.play(); } catch (e) { p = null; }
        if (p && p.catch) p.catch(function () {});
        var t0 = Date.now();
        while (Date.now() - t0 < 2500 && video.paused) { await sleep(200); }
        if (!video.paused) return;
        var btns = findPlayButtons();
        var clicked = false;
        for (var i = 0; i < btns.length; i++) { realClick(btns[i]); clicked = true; }
        if (clicked) await sleep(700);
    }
    function loadVideoRate() {
        try {
            var r = parseFloat(localStorage.getItem('mar.video.rate'));
            if (r >= 0.5 && r <= 3) return r;
        } catch (e) {}
        return 1;
    }
    function saveVideoRate(r) {
        try { localStorage.setItem('mar.video.rate', String(r)); } catch (e) {}
    }
    function applyVideoRate(video) {
        var r = loadVideoRate();
        try { if (video && Math.abs(video.playbackRate - r) > 0.01) video.playbackRate = r; } catch (e) {}
    }
    function findQuizPopup() {
        var video = findVideo();
        if (!video) return null;
        var sels = [
            '[class*="dialog"]', '[class*="modal"]', '[class*="popup"]', '[class*="layer"]', '[class*="overlay"]',
            '[class*="question"]', '[class*="quiz"]', '[class*="Quiz"]', '[class*="testQuestion"]',
            '[class*="interaction"]', '[class*="ask"]', '[class*="topic"]',
        ];
        for (var s = 0; s < sels.length; s++) {
            var els;
            try { els = document.querySelectorAll(sels[s]); } catch (e) { continue; }
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (!isVisible(el)) continue;
                if (el.clientWidth < 220 || el.clientHeight < 120) continue;
                if (el.closest && el.closest('[class*="catalog"], [class*="sidebar"], [class*="menu"]')) continue;
                var txt = cleanText(el.textContent).slice(0, 400);
                if (!txt) continue;
                var strong = /请选择|请回答|请作答|单选题|多选题|判断题|填空题/.test(txt);
                var markers = strong || /本题|选项|[A-H]\s*[\.、．）)]/.test(txt);
                if (!markers) continue;
                if (!video.paused && !strong) continue;
                var hasOpt = false, hasSub = false, o, b;
                var opts = el.querySelectorAll('input[type="radio"], input[type="checkbox"], label, [class*="option"], [class*="choice"], [class*="answer"]');
                for (o = 0; o < opts.length; o++) { if (isVisible(opts[o])) { hasOpt = true; break; } }
                var subs = el.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
                for (b = 0; b < subs.length; b++) { if (isVisible(subs[b])) { hasSub = true; break; } }
                if (!hasOpt && !hasSub) continue;
                return el;
            }
        }
        return null;
    }
    var lastQuizContinueAt = 0;
    function clickQuizContinue(popup) {
        if (taskState.cancelled || manualWaitFlag || !findVideo()) return false;
        if (lastQuizContinueAt && Date.now() - lastQuizContinueAt < 1200) return false;
        var scopes = popup ? [popup] : [];
        var candidates = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"], [class*="question"], [class*="quiz"], [class*="Quiz"]');
        for (var i = 0; i < candidates.length; i++) {
            var scope = candidates[i];
            if (!isVisible(scope) || scope.clientWidth < 220 || scope.clientHeight < 120) continue;
            if (/回答错误|回答正确|正确答案|答案解析|回答结果/.test(cleanText(scope.textContent || ''))) scopes.push(scope);
        }
        for (var j = 0; j < scopes.length; j++) {
            if (!isVisible(scopes[j])) continue;
            var buttons = scopes[j].querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"], .j-continue');
            for (var k = 0; k < buttons.length; k++) {
                var button = buttons[k];
                if (!isVisible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
                var text = cleanText(button.textContent || button.value || '').replace(/\s+/g, '');
                if (text !== '继续学习') continue;
                if (button.scrollIntoView) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                lastQuizContinueAt = Date.now();
                realClick(button);
                logDebug('quiz', '已点击视频弹题的“继续学习”按钮');
                updateStatus('▶ 已点击继续学习，等待视频恢复...');
                return true;
            }
        }
        return false;
    }
    async function answerQuizPopup(popup) {
        if (clickQuizContinue(popup)) return true;
        var i, clickedOpt = false;
        var radios = popup.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        for (i = 0; i < radios.length; i++) {
            if (isVisible(radios[i]) && !radios[i].disabled) { realClick(radios[i]); clickedOpt = true; break; }
        }
        if (!clickedOpt) {
            var opts = popup.querySelectorAll('label, li, [class*="option"], [class*="choice"], [class*="answer"], [class*="selectItem"]');
            for (i = 0; i < opts.length; i++) {
                var el = opts[i];
                if (!isVisible(el)) continue;
                var t = cleanText(el.textContent);
                if (!t || t.length > 120) continue;
                if (/^(确定|提交|完成|继续|关闭|下一题|保存|我知道了|重试)$/.test(t)) continue;
                realClick(el); clickedOpt = true; break;
            }
        }
        if (!clickedOpt) updateStatus('⚠️ 题目弹窗里没找到选项，先尝试直接提交');
        await sleep(500);
        var btns = popup.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"], div[role="button"], span[role="button"]');
        var SUBMIT = /^(提交|确定|完成|继续|下一题|保存|提交答案|确认|知道了)$/;
        for (i = 0; i < btns.length; i++) {
            var el2 = btns[i];
            if (!isVisible(el2) || el2.disabled) continue;
            var tt = cleanText(el2.textContent || el2.value || '').slice(0, 6);
            if (SUBMIT.test(tt)) { realClick(el2); return true; }
        }
        return clickedOpt;
    }

    async function waitForVideo() {
        var t0 = Date.now();
        while (Date.now() - t0 < 20000) {
            if (taskState.cancelled) throw makeCancelError();
            var v = findVideo();
            if (v) return v;
            await sleep(500);
        }
        return null;
    }

    // 只比较课程、课件和视频单元；完成标记、标题、追踪参数和 hash 不属于身份。
    function videoUnitContext() {
        var url = new URL(location.href);
        return {
            path: url.pathname.replace(/\/+$/, ''),
            term: url.searchParams.get('tid') || '',
            unit: url.searchParams.get('unitId') || ''
        };
    }

    function contentUnitChanged(context, current) {
        return current.path !== context.path ||
            (context.term && current.term && context.term !== current.term) ||
            (context.unit && current.unit && context.unit !== current.unit);
    }

    function followCurrentContent(context) {
        if (taskState.cancelled) throw makeCancelError();
        var current = videoUnitContext();
        var course = function (path) { return path.replace(/\/content\/\d+$/, ''); };
        if (!/\/content\/\d+$/.test(current.path) || course(context.path) !== course(current.path) ||
            (context.term && current.term && context.term !== current.term)) {
            throw makeCancelError('已离开原课程或学期，停止旧课程任务');
        }
        recordRunEvent('follow', '同课程内容已切换，接着处理当前项，不重复点击下一节：' + JSON.stringify(context) + ' → ' + JSON.stringify(current));
        updateStatus('➡️ 页面已进入下一项，接着学习当前内容...');
        return 'navigated';
    }

    // 平台可能先更新路由再替换播放器，不能把残留的旧 ended 视频当作新视频。
    async function waitForSwitchedPlayer(previous) {
        var started = Date.now();
        while (Date.now() - started < CONFIG.LEARN_CONTENT_READY_WAIT) {
            if (taskState.cancelled) throw makeCancelError();
            var video = findVideo();
            if (!video) return true; // 文档等内容交给正常的内容就绪检查。
            if (!previous.video || video !== previous.video) return true;
            var source = video.currentSrc || video.src || '';
            if (previous.source && source && source !== previous.source) return true;
            if (!previous.source && !video.ended && !video.__marEndedFlag) return true;
            await sleep(500);
        }
        updateStatus('⚠️ 页面已切换，但旧播放器尚未替换，自动学习暂停，请检查页面');
        return false;
    }

    async function learnVideoItem() {
        var video = await waitForVideo();
        if (!video) { logDebug('video', '⚠️ 未检测到播放器，保留当前项'); updateStatus('⚠️ 未检测到播放器，自动学习暂停，保留当前项'); return false; }
        var completionContext = videoUnitContext();
        if (video.ended) {
            logDebug('video', '视频已经结束，直接进入下一项，不重新播放');
            return true;
        }
        video.__marEndedFlag = false; // 连续视频复用播放器时，清除上一视频的结束标记
        if (!video.__marEndedHook) {
            video.__marEndedHook = true;
            video.addEventListener('ended', function () {
                try { video.__marEndedFlag = true; } catch (e) {}
            });
        }
        logDebug('video', '从当前位置 ' + Math.floor(video.currentTime || 0) + ' 秒继续播放：时长=' + (video.duration ? video.duration.toFixed(1) : '?') + 's，倍速=' + loadVideoRate() + 'x');
        updateStatus('▶ 从当前位置 ' + Math.floor(video.currentTime || 0) + ' 秒继续播放...');
        await playVideo(video);

        var manualResume = false;
        var lastAnswerAt = 0;
        var lastRetry = 0;
        while (!taskState.cancelled) {
            if (contentUnitChanged(completionContext, videoUnitContext())) return followCurrentContent(completionContext);
            video = findVideo() || video;
            applyVideoRate(video); // 持续应用倍速（切清晰度/拖动进度后平台可能重置）
            if (manualWaitFlag) { logDebug('video', '用户点击【下一节】，跳过当前视频'); updateStatus('⏭ 用户点击【下一节】，跳过当前视频'); return true; }
            if (clickQuizContinue(findQuizPopup())) {
                await sleep(400);
                var continuedVideo = findVideo();
                if (continuedVideo && continuedVideo.paused && !findQuizPopup()) await playVideo(continuedVideo);
                continue;
            }
            var popup = findQuizPopup();
            if (popup && Date.now() - lastAnswerAt > 2500) {
                lastAnswerAt = Date.now();
                updateStatus('📝 视频中弹出题目，自动作答（不保证对错，只为让视频继续）...');
                logDebug('quiz', '视频中弹出题目，自动作答...');
                await answerQuizPopup(popup);
                var t0 = Date.now(), resumed = false;
                while (Date.now() - t0 < CONFIG.LEARN_QUIZ_RESUME_WAIT) {
                    await sleep(CONFIG.LEARN_IDLE_POLL);
                    var clickedContinue = clickQuizContinue(findQuizPopup());
                    var vv = findVideo();
                    if (clickedContinue && vv && vv.paused && !findQuizPopup()) await playVideo(vv);
                    if (vv && !vv.paused && vv.currentTime > 0) { resumed = true; break; }
                }
                if (resumed) {
                    logDebug('quiz', '✅ 弹题处理完成，视频已继续');
                    updateStatus('✅ 题目已答，平台放行，视频自动继续播放');
                } else {
                    logDebug('quiz', '视频尚未恢复，继续检测“继续学习”按钮');
                    updateStatus('⏳ 视频尚未恢复，持续检测“继续学习”按钮...');
                    manualResume = false;
                }
                continue;
            }
            if (video.ended || (video.__marEndedFlag && Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.05)) {
                logDebug('video', '🎬 播放完毕（currentTime=' + (video.currentTime || 0).toFixed(1) + '/duration=' + (video.duration || 0).toFixed(1) + '）');
                return true;
            }
            if (video.paused && !manualResume && Date.now() - lastAnswerAt > 2500 && Date.now() - lastRetry > 2500) {
                lastRetry = Date.now();
                await playVideo(video);
            }
            await sleep(CONFIG.LEARN_IDLE_POLL);
        }
        return false;
    }
    function findDocViewer() {
        var sels = [
            '[class*="mooc-docs-reader"]', '[class*="docs-reader"]', '[class*="mooc-doc"]',
            '[class*="doc-viewer"]', '[class*="docViewer"]', '[class*="document-viewer"]',
            '[class*="pptViewer"]', '[class*="ppt-viewer"]', '[class*="pdfViewer"]', '[class*="pdf-viewer"]',
            '[class*="slideViewer"]', '[class*="slide-viewer"]', '[class*="coursewareViewer"]',
            '[class*="course-doc"]', '[class*="courseDoc"]', '[class*="docContent"]', '[class*="doc-content"]',
            '[class*="docPage"]', '[class*="doc-page"]', '[class*="slidePage"]', '[class*="slide-page"]',
            '[class*="attachmentPage"]', '[class*="attachment-page"]',
        ];
        for (var s = 0; s < sels.length; s++) {
            var els;
            try { els = document.querySelectorAll(sels[s]); } catch (e) { continue; }
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (!isVisible(el)) continue;
                if (el.clientHeight < 120 || el.clientWidth < 200) continue;
                if (el.closest && el.closest('[class*="catalog"], [class*="sidebar"], [class*="menu"], [class*="nav"]')) continue;
                return el;
            }
        }
        var imgs = document.querySelectorAll('img');
        for (i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            if (!isVisible(im)) continue;
            if (im.clientWidth < 200 || im.clientHeight < 150) continue;
            if (im.closest && im.closest('[class*="catalog"], [class*="avatar"], [class*="header"], [class*="footer"], [class*="qr"]')) continue;
            return im.closest('div, section') || im;
        }
        return null;
    }
    function findDocNextBtn() {
        var scope = findDocViewer() || document;
        var thumbs = scope.querySelectorAll('.mooc-docs-reader__thumbnail, [class*="mooc-docs-reader__thumbnail"]');
        if (thumbs.length > 0) {
            for (var t = 0; t < thumbs.length - 1; t++) {
                if (thumbs[t].classList.contains('is-active')) return thumbs[t + 1];
            }
            return null; // 已在最后一页
        }
        var els = scope.querySelectorAll(
            'button, a, span, [role="button"], input[type="button"], input[type="submit"], ' +
            '[class*="next"], [class*="Next"], [class*="turn"], [class*="arrow"], [class*="Arrow"]'
        );
        var NEXT_TEXT = /^(下一页|下一张|后一页|下一|下页|下一个|»|›|>|＞)$/;
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!isVisible(el) || el.disabled) continue;
            var label = el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('title') || '') : '';
            var txt = cleanText((el.textContent || '').slice(0, 8));
            if (NEXT_TEXT.test(txt) || /下一页|下一张/.test(label)) return el;
            var cls = String(el.className || '');
            if (/next|Next|turnRight|arrow-right|arrowRight/.test(cls) && el.clientWidth > 0 && el.clientWidth < 200) return el;
        }
        return null;
    }
    function docPageInfo() {
        var thumbs = document.querySelectorAll('.mooc-docs-reader__thumbnail, [class*="mooc-docs-reader__thumbnail"]');
        if (thumbs.length > 0) {
            var cur = 0;
            for (var t = 0; t < thumbs.length; t++) {
                if (thumbs[t].classList.contains('is-active')) { cur = t + 1; break; }
            }
            return { cur: cur, total: thumbs.length };
        }
        var els = document.querySelectorAll(
            '[class*="pageNum"], [class*="page-num"], [class*="pageInfo"], [class*="page-info"], ' +
            '[class*="pager"], [class*="pagination"], [class*="indicator"], .zpgi, .zcnt'
        );
        for (var i = 0; i < els.length; i++) {
            var m = (els[i].textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
            if (m) return { cur: parseInt(m[1], 10), total: parseInt(m[2], 10) };
        }
        return null;
    }
    function docPageSignature() {
        var scope = findDocViewer();
        if (!scope) return '';
        var thumbs = scope.querySelectorAll('.mooc-docs-reader__thumbnail, [class*="mooc-docs-reader__thumbnail"]');
        if (thumbs.length > 0) {
            var cur = 0;
            for (var t = 0; t < thumbs.length; t++) {
                if (thumbs[t].classList.contains('is-active')) { cur = t + 1; break; }
            }
            return 'reader:' + cur + '/' + thumbs.length;
        }
        var imgs = scope.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            if (isVisible(im) && im.src && im.clientWidth >= 100) return im.src;
        }
        var txt = scope.textContent || '';
        return String(txt.length) + ':' + txt.slice(-60);
    }
    async function scrollDocFallback() {
        var viewer = findDocViewer();
        var sc = (viewer && viewer.scrollHeight > viewer.clientHeight + 40) ? viewer : (document.scrollingElement || document.documentElement);
        var before = sc.scrollTop;
        sc.scrollTop += Math.max(300, Math.min(800, window.innerHeight * 0.7));
        await sleep(CONFIG.LEARN_DOC_PAGE_MS);
        return sc.scrollTop > before + 10;
    }
    async function learnDocItem() {
        logDebug('doc', '开始自动翻页（每页 1 秒）...');
        updateStatus('📄 检测到文档，开始自动翻页（每页 1 秒）...');
        var flips = 0, stale = 0, lastSig = docPageSignature(), lastInfo = docPageInfo();
        while (!taskState.cancelled && flips < CONFIG.LEARN_MAX_PAGE_FLIPS) {
            if (manualWaitFlag) { logDebug('doc', '用户点击【下一节】，跳过当前文档'); updateStatus('⏭ 用户点击【下一节】，跳过当前文档'); return true; }
            var btn = findDocNextBtn();
            if (!btn) {
                var info = docPageInfo();
                if (info && info.total > 0) {
                    logDebug('doc', '翻页结束（已到最后一页 ' + info.cur + '/' + info.total + '）');
                    updateStatus('📄 文档翻页结束（已到最后一页），进入下一个内容');
                    return true;
                }
                var moved = await scrollDocFallback();
                if (!moved) { logDebug('doc', '已到文档末尾（无翻页按钮）'); updateStatus('📄 已到文档末尾（无翻页按钮），进入下一个内容'); return true; }
                continue;
            }
            realClick(btn);
            await sleep(CONFIG.LEARN_DOC_PAGE_MS);
            flips++;
            var sig = docPageSignature();
            var info2 = docPageInfo();
            var changed = (sig && sig !== lastSig) || (info2 && lastInfo && (info2.cur > lastInfo.cur || info2.total !== lastInfo.total));
            if (changed) { stale = 0; lastSig = sig || lastSig; lastInfo = info2 || lastInfo; }
            else {
                stale++;
                if (stale >= 3) { logDebug('doc', '翻页结束（连续 ' + stale + ' 页无变化）'); updateStatus('📄 文档翻页结束（已到最后一页），进入下一个内容'); return true; }
            }
            if (flips % 10 === 0) updateStatus('📄 文档翻页中... 已翻 ' + flips + ' 页');
        }
        logDebug('doc', '文档处理完成（翻 ' + flips + ' 页）');
        updateStatus('📄 文档处理完成，进入下一个内容');
        return true;
    }
    function looksLikeDiscussionPage() {
        if (/forum|discuss|discussion|topic/i.test(location.pathname + location.hash)) return true;
        return !!document.querySelector('[class*="mooc-comment"], .m-data-lists, [class*="discussion-content"]');
    }
    function detectContentType() {
        var href = location.href, hash = location.hash;
        var bodyHead = cleanText((document.body ? document.body.textContent : '') || '').slice(0, 300);
        if (/课件不存在|课件加载失败|unitId[\s\S]{0,20}不匹配|lessonId[\s\S]{0,20}不匹配|内容不存在|资源不存在/.test(bodyHead)) { logDebug('type', 'missing：页面显示课件不存在/unitId不匹配类文案'); return 'missing'; }
        if (findVideo()) { logDebug('type', 'video：检测到播放器'); return 'video'; }
        if (findDocViewer()) { logDebug('type', 'doc：检测到文档查看器'); return 'doc'; }
        if (PAGE_CONFIG.quizUrl.test(href) || hasVisibleQuestionBlocks()) { logDebug('type', 'quiz：URL 命中测验路由或检测到题目块'); return 'quiz'; }
        if (looksLikeDiscussionPage()) { logDebug('type', 'discussion：讨论页特征命中'); return 'discussion'; }
        logDebug('type', 'other：未命中视频/文档/讨论/测验特征（富文本/节标题页等）');
        return 'other';
    }
    var LEARN_STATE_KEY = 'mooc.merged.learn.state.v2'; // 每个标签页独立，刷新后保留；不导入旧的共享计划

    function learnSaveState(st) {
        try { sessionStorage.setItem(LEARN_STATE_KEY, JSON.stringify(st)); } catch (e) { logDebug('state', '无法保存学习计划，刷新后可能中断：' + e.message); }
    }
    function learnLoadState() {
        try {
            var s = sessionStorage.getItem(LEARN_STATE_KEY);
            if (!s) return null;
            var o = JSON.parse(s);
            return o && o.running ? o : null;
        } catch (e) { return null; }
    }
    function learnClearState() {
        try { sessionStorage.removeItem(LEARN_STATE_KEY); } catch (e) {}
    }
    function waitForElement(selector, timeout, root) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            (function check() {
                if (taskState.cancelled) { resolve(null); return; }
                var el;
                try { el = (root || document).querySelector(selector); } catch (e) { el = null; }
                if (el && isVisible(el)) { resolve(el); return; }
                if (Date.now() - t0 >= timeout) { resolve(null); return; }
                setTimeout(check, 200);
            })();
        });
    }
    function contentTabKey(tab) {
        return tab ? cleanText(tab.getAttribute('aria-label') || tab.textContent || '')
            .replace(/[（(](?:已完成|未完成|未学习|未学完)[）)]/g, '').trim() : '';
    }
    function freshContentTab(key) {
        var tabs = contentTabs();
        for (var i = 0; i < tabs.length; i++) if (contentTabKey(tabs[i]) === key) return tabs[i];
        return null;
    }
    async function waitForTabActive(tab) {
        var key = contentTabKey(tab), t0 = Date.now();
        if (!key) return false;
        while (Date.now() - t0 < CONFIG.LEARN_NAV_WAIT) {
            if (taskState.cancelled) return false;
            // React 重绘后原节点可能已被移除，必须从当前目录重新定位。
            var current = freshContentTab(key);
            if (current && current.getAttribute('aria-selected') === 'true') return true;
            await sleep(200);
        }
        var latest = freshContentTab(key);
        return !!(!taskState.cancelled && latest && latest.getAttribute('aria-selected') === 'true');
    }
    async function activateContentTab(tab) {
        var key = contentTabKey(tab), before = videoUnitContext();
        for (var attempt = 0; attempt < 2; attempt++) {
            if (taskState.cancelled) throw makeCancelError();
            if (contentUnitChanged(before, videoUnitContext())) {
                followCurrentContent(before);
                return true; // 平台已经切换，不再点击旧目标。
            }
            var target = freshContentTab(key);
            if (!target) { await sleep(300); continue; }
            if (target.getAttribute('aria-selected') === 'true') return true;
            recordRunEvent('tab-click', '进入标签「' + key + '」，第 ' + (attempt + 1) + ' 次');
            // 使用浏览器原生 click，避免手工 mousedown 导致重绘后向旧节点派发 click。
            if (typeof target.click === 'function') target.click();
            else realClick(target);
            if (await waitForTabActive(target)) return true;
        }
        if (contentUnitChanged(before, videoUnitContext())) { followCurrentContent(before); return true; }
        recordRunEvent('tab-timeout', '目标「' + key + '」，当前「' + contentTabKey(currentContentTab()) + '」；重试后仍未确认切换');
        return false;
    }
    function currentContentTab() {
        var tabs = document.querySelectorAll('[role="tab"][aria-selected="true"]');
        for (var i = 0; i < tabs.length; i++) if (isVisible(tabs[i])) return tabs[i];
        return null;
    }
    function contentTabs() {
        var out = [];
        var lists = document.querySelectorAll('[role="tablist"]');
        for (var l = 0; l < lists.length; l++) {
            var ts = lists[l].querySelectorAll('[role="tab"]');
            for (var i = 0; i < ts.length; i++) if (isVisible(ts[i])) out.push(ts[i]);
        }
        return out;
    }
    function headerDropdowns() {
        var btns = document.querySelectorAll('header button[aria-expanded], [class*="header"] button[aria-expanded], nav button[aria-expanded], button[aria-expanded]');
        var chapter = null, section = null;
        for (var i = 0; i < btns.length; i++) {
            if (!isVisible(btns[i])) continue;
            var label = btns[i].getAttribute('aria-label') || '';
            if (!label) continue;
            var cls = typeof btns[i].className === 'string' ? btns[i].className : (btns[i].getAttribute ? (btns[i].getAttribute('class') || '') : '');
            if (/learn-header-action|learn-header-more|learn-agent|more-toggle|more-menu/.test(cls)) continue;
            if (/更多课程操作|打开.*助教|更多|收起|关闭/.test(label)) continue;
            if (looksLikeChapterHeading(label)) { if (!chapter) chapter = btns[i]; }
            else { if (!section) section = btns[i]; }
        }
        logDebug('nav', '章节按钮=' + (chapter ? (chapter.getAttribute('aria-label') || '?') : '未找到')
            + ' | 小节按钮=' + (section ? (section.getAttribute('aria-label') || '?') : '未找到'));
        return { chapter: chapter, section: section };
    }
    function menuItemSels() {
        return [
            '[role="menuitem"]', '[role="option"]', '[class*="menuitem"]', '[class*="menu-item"]',
            '[class*="dropdown"] a', '[class*="dropdown"] li', '[class*="dropdown"] button',
            '[class*="popover"] a', '[class*="popover"] li', '[class*="popup"] a', '[class*="popup"] li',
            '[class*="option"]', '[class*="choice"]', '[class*="select"] a', '[class*="select"] li',
            'a', 'li', 'button',
        ];
    }
    async function expandDropdown(btn) {
        if (!btn) return null;
        var before = collectCandidates(document, ['[role="menu"]', '[role="listbox"]', '[class*="dropdown"]', '[class*="popover"]', '[class*="popup"]', '[class*="select-list"]'], 40);
        if (btn.getAttribute('aria-expanded') !== 'true') { realClick(btn); }
        await sleep(400);
        var fallbackPanel = null;
        var node = btn;
        for (var depth = 0; node && depth < 5; depth++) {
            var parent = node.parentElement;
            if (!parent) break;
            var sels = ['[role="menu"]', '[role="listbox"]', '[class*="dropdown-menu"]', '[class*="dropdown"]', '[class*="popover"]', '[class*="popup"]'];
            for (var s = 0; s < sels.length; s++) {
                var p;
                try { p = parent.querySelector(sels[s]); } catch (e) { continue; }
                if (p && isVisible(p)) {
                    if (before.indexOf(p) === -1) return p;
                    if (!fallbackPanel) fallbackPanel = p;
                }
            }
            node = parent;
        }
        var els = document.querySelectorAll('[role="menu"], [role="listbox"], [class*="dropdown-menu"], [class*="dropdown"], [class*="popover"], [class*="popup"]');
        var anyPanel = null;
        for (var i = 0; i < els.length; i++) {
            if (isVisible(els[i])) {
                if (before.indexOf(els[i]) === -1) return els[i];
                if (!anyPanel) anyPanel = els[i];
            }
        }
        return anyPanel || fallbackPanel || null;
    }
    function isClickableEl(el) {
        var tag = el.tagName;
        if (tag === 'A' || tag === 'BUTTON' || tag === 'LI') return true;
        var role = el.getAttribute ? (el.getAttribute('role') || '') : '';
        return role === 'option' || role === 'menuitem' || role === 'tab' || role === 'button';
    }
    function itemFullText(el) {
        var node = el;
        if (el.closest) {
            var up = el.closest('a, li, button, [role="option"], [role="menuitem"], [role="tab"]');
            if (up && up !== el) node = up;
        }
        return cleanText(node.textContent).slice(0, 40);
    }
    function dedupeClickable(raw) {
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var el = raw[i];
            var skip = false;
            for (var j = 0; j < raw.length; j++) {
                if (i !== j && raw[j] !== el && raw[j].contains(el) && isClickableEl(raw[j])) { skip = true; break; }
            }
            if (!skip) out.push(el);
        }
        return out;
    }
    function menuItemsOf(panel) {
        var raw = collectCandidates(panel, menuItemSels(), 160);
        var out = dedupeClickable(raw);
        out.sort(function (a, b) {
            if (a.compareDocumentPosition && b.compareDocumentPosition) {
                return (a.compareDocumentPosition(b) & 4) ? -1 : 1;
            }
            return 0;
        });
        return out;
    }
    async function findDropdownItems(btn) {
        var before = collectCandidates(document, menuItemSels(), 160);
        var panel = await expandDropdown(btn);
        var items = []; // 必须初始化：panel 为 null 时保持空数组，避免后续 items.length 崩溃
        if (panel) {
            items = menuItemsOf(panel);
            if (items.length === 0 && panel.scrollTop !== undefined) {
                try { panel.scrollTop = panel.scrollHeight; } catch (e) {}
                await sleep(400);
                items = menuItemsOf(panel);
            }
            if (items.length > 0) return items;
        }
        var after = collectCandidates(document, menuItemSels(), 160);
        var news = [];
        for (var i = 0; i < after.length; i++) {
            if (before.indexOf(after[i]) === -1) news.push(after[i]);
        }
        var out = dedupeClickable(news);
        logDebug('menu', '下拉项(面板模式)=' + items.length + ' → diff兜底=' + out.length
            + ' | 面板=' + (panel ? (panel.className ? String(panel.className).slice(0, 40) : panel.tagName) : 'null'));
        return out;
    }
    function clickMenuItem(el) {
        var target = el;
        if (el.closest) {
            var up = el.closest('a, li, button, [role="option"], [role="menuitem"], [role="tab"]');
            if (up && up !== el) target = up;
        }
        try { if (target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        realClick(target);
    }
    function isGroupTitle(t) {
        return /^第[一二三四五六七八九十百\d]+\s*节/.test(t) && !/^\s*\d+(\.\d+)+/.test(t);
    }
    function normMatch(s) {
        return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '');
    }
    function nextOfMenuItems(items, currentLabel) {
        if (!items || items.length === 0) return null;
        var target = normMatch(currentLabel);
        var idx = -1;
        for (var i = 0; i < items.length; i++) {
            var full = itemFullText(items[i]);
            var t = normMatch(full);
            if (!t) continue;
            if (target && (t === target || t.indexOf(target) !== -1 || target.indexOf(t) !== -1)) { idx = i; break; }
        }
        if (idx === -1) return null; // 没找到当前项，无法确定“下一个”
        var ret = (idx + 1 < items.length) ? items[idx + 1] : null;
        logDebug('menu', '匹配「' + (String(currentLabel || '').slice(0, 20)) + '」→ idx=' + idx
            + (ret ? '，下一个=「' + itemFullText(ret).slice(0, 24) + '」' : '，无下一个（当前是最后一项）'));
        return ret;
    }
    function tabIsQuiz(tab) {
        var label = (tab.getAttribute && (tab.getAttribute('aria-label') || '')) || '';
        var txt = cleanText((tab.textContent || '')).slice(0, 30);
        return /测验|测试|考试|自测|小测|quiz/i.test(label) || /测验|测试|考试|自测|小测|quiz/i.test(txt);
    }
    function nextTabSkipQuiz(fromTab) {
        var s = fromTab, skipped = [];
        while (s) {
            s = s.nextElementSibling;
            if (!s) return null;
            if (s.getAttribute && s.getAttribute('role') === 'tab' && isVisible(s)) {
                if (tabIsQuiz(s)) { skipped.push(cleanText((s.textContent || '')).slice(0, 12)); continue; } // 跳过测验标签
                if (skipped.length) logDebug('nav', '同小节内跳过测验标签：' + skipped.join('、'));
                return s;
            }
        }
        return null;
    }
    function firstNonQuizTab(tabs) {
        for (var i = 0; i < tabs.length; i++) {
            if (!tabIsQuiz(tabs[i])) return tabs[i];
        }
        return null;
    }
    async function waitForTablistRefresh(oldTab) {
        var t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            if (taskState.cancelled) return null;
            var tabs = contentTabs();
            if (tabs.length > 0) {
                var changed = false;
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i] !== oldTab) { changed = true; break; }
                }
                if (changed) {
                    logDebug('nav', 'tablist 已刷新：' + tabs.length + ' 个内容标签，等待耗时 ' + (Date.now() - t0) + 'ms');
                    return tabs;
                }
            }
            await sleep(200);
        }
        logDebug('nav', '⚠️ tablist 刷新超时（10 秒内旧元素未被替换）');
        return null;
    }
    async function pickNextSectionItem() {
        var dd = headerDropdowns();
        if (!dd.section) { logDebug('nav', '⚠️ 未找到「小节」下拉按钮'); return null; }
        var name = dd.section.getAttribute('aria-label') || '';
        logDebug('nav', '跨小节决策：小节名=「' + name.slice(0, 24) + '」');
        var items = await findDropdownItems(dd.section);
        var next = nextOfMenuItems(items, name);
        if (!next) {
            logDebug('nav', '小节下拉无下一项 → 判定当前小节是本章最后一项，进入跨章节');
            if (dd.section.getAttribute('aria-expanded') === 'true') realClick(dd.section);
            return null;
        }
        logDebug('nav', '跨小节目标=「' + itemFullText(next).slice(0, 24) + '」');
        return next;
    }
    async function pickNextChapterItem() {
        var dd = headerDropdowns();
        if (!dd.chapter) { logDebug('nav', '⚠️ 未找到「章节」下拉按钮'); return null; }
        var name = dd.chapter.getAttribute('aria-label') || '';
        logDebug('nav', '跨章节决策：章节名=「' + name.slice(0, 24) + '」');
        var items = await findDropdownItems(dd.chapter);
        var next = nextOfMenuItems(items, name);
        if (!next) {
            logDebug('nav', '章节下拉无下一项 → 判定全部章节学完');
            if (dd.chapter.getAttribute('aria-expanded') === 'true') realClick(dd.chapter);
            return null;
        }
        logDebug('nav', '跨章节目标=「' + itemFullText(next).slice(0, 24) + '」');
        return next;
    }
    async function doSectionJump(item) {
        var oldTab = currentContentTab();
        clickMenuItem(item);
        updateStatus('📚 跨小节：进入下一节，自动播放第一个内容...');
        var tabs = await waitForTablistRefresh(oldTab);
        if (!tabs || tabs.length === 0) {
            logDebug('nav', '⚠️ 点击「' + itemFullText(item).slice(0, 20) + '」后 tablist 未刷新，改点该节第一个内容单元');
            var dd = headerDropdowns();
            if (dd.section) {
                var items = await findDropdownItems(dd.section);
                var idx = items.indexOf(item);
                var nextContent = null;
                for (var j = idx + 1; j < items.length; j++) {
                    var ft = itemFullText(items[j]);
                    if (ft && !isGroupTitle(ft)) { nextContent = items[j]; break; }
                }
                if (nextContent) {
                    clickMenuItem(nextContent);
                    tabs = await waitForTablistRefresh(oldTab);
                }
            }
        }
        if (!tabs || tabs.length === 0) return false;
        var first = firstNonQuizTab(tabs) || tabs[0];
        realClick(first);
        await waitForTabActive(first);
        return true;
    }
    async function doChapterJump(item) {
        var oldTab = currentContentTab();
        clickMenuItem(item);
        updateStatus('📕 跨章节：进入下一章，自动播放第一个内容...');
        var tabs = await waitForTablistRefresh(oldTab);
        if (!tabs || tabs.length === 0) {
            var dd2 = headerDropdowns();
            if (dd2.section) {
                var items2 = await findDropdownItems(dd2.section);
                if (items2.length > 0) { clickMenuItem(items2[0]); await sleep(600); }
            }
            tabs = await waitForTablistRefresh(oldTab);
        }
        if (!tabs || tabs.length === 0) return false;
        var first = firstNonQuizTab(tabs) || tabs[0];
        realClick(first);
        await waitForTabActive(first);
        return true;
    }
    async function goNext() {
        var curTab = currentContentTab();
        if (!curTab) {
            logDebug('nav', '当前激活 tab 未找到，等待出现...');
            curTab = await waitForElement('[role="tab"][aria-selected="true"]', 5000);
            if (!curTab) { logDebug('nav', '❌ 5 秒后仍无激活 tab'); updateStatus('❌ 未找到当前内容标签，无法跳转'); return false; }
        }
        logDebug('nav', 'goNext 入口：当前激活 tab=「' + (curTab.getAttribute('aria-label') || cleanText(curTab.textContent).slice(0, 20)) + '」');
        var target = nextTabSkipQuiz(curTab);
        if (target) {
            updateStatus('➡️ 同小节：进入下一个内容');
            logDebug('nav', '优先级1 同小节：点击「' + (target.getAttribute('aria-label') || cleanText(target.textContent).slice(0, 20)) + '」');
            if (!await activateContentTab(target)) {
                updateStatus('同小节标签切换超时，自动学习暂停，请检查页面');
                return false;
            }
            return true;
        }
        logDebug('nav', '优先级1 无下一个同小节 tab（已到本节末尾）');
        var secItem = await pickNextSectionItem();
        if (secItem) {
            if (await doSectionJump(secItem)) return true;
            updateStatus('⚠️ 跨小节执行失败，10 秒后自动重试...');
            logDebug('nav', '⚠️ 跨小节失败，10 秒后重试');
            await sleepWhile(10000, function () { return manualWaitFlag; });
            secItem = await pickNextSectionItem();
            if (secItem && await doSectionJump(secItem)) return true;
            logDebug('nav', '⚠️ 跨小节连续失败');
            updateStatus('⚠️ 跨小节连续失败：请手动点击「小节」下拉切换，或检查顶部按钮结构');
            return false;
        }
        var chapItem = await pickNextChapterItem();
        if (chapItem) {
            if (await doChapterJump(chapItem)) return true;
            logDebug('nav', '⚠️ 跨章节执行失败');
            updateStatus('⚠️ 跨章节执行失败：请手动点击「章节」下拉切换，或检查顶部按钮结构');
            return false;
        }
        logDebug('nav', '🏁 三级跳转全部无目标 → 课程学习完成');
        updateStatus('未找到后续内容；可能已到课程末尾，如未学完请检查章节目录');
        recordRunEvent('navigation', '目录检查未找到后续内容，结束本轮自动学习');
        return false;
    }
    function hasVisibleContentBody() {
        var sels = [
            'main p', 'main h1', 'main h2', 'main h3', 'main h4',
            '[class*="content"] p', '[class*="content"] h1', '[class*="content"] h2', '[class*="content"] h3',
            '[class*="lesson"] p', '[class*="learn-content"] p', '[class*="rich-text"] p',
            '[class*="section-title"]', '[class*="chapter-title"]', '[class*="lesson-title"]',
            '[class*="learn-section"]', '[class*="learn-lesson-title"]',
        ];
        var hits = collectCandidates(document, sels, 80);
        for (var i = 0; i < hits.length; i++) {
            var el = hits[i];
            if (!isVisible(el)) continue;
            var t = cleanText((el.textContent || '')).slice(0, 80);
            if (!t || t.length < 2) continue;
            if (/MOOC 助手|自动学习|停止当前操作|页面 DOM 诊断|开始自动学习|加载中|loading|努力加载/.test(t)) continue;
            var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (r && (r.width < 60 || r.height < 20)) continue;
            return true;
        }
        return false;
    }
    async function waitContentReady(timeout) {
        var t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            if (taskState.cancelled) return false;
            if (findVideo()) { logDebug('load', '内容就绪：video（' + (Date.now() - t0) + 'ms）'); return true; }
            if (activeTabIsVideo()) { await sleep(500); continue; }
            if (findDocViewer()) { logDebug('load', '内容就绪：文档查看器（' + (Date.now() - t0) + 'ms）'); return true; }
            if (looksLikeDiscussionPage()) { logDebug('load', '内容就绪：讨论页（' + (Date.now() - t0) + 'ms）'); return true; }
            if (hasVisibleContentBody()) { logDebug('load', '内容就绪：富文本/标题页正文（' + (Date.now() - t0) + 'ms）'); return true; }
            await sleep(500);
        }
        logDebug('load', '⚠️ 内容加载超时（' + timeout + 'ms 内未见任何正文）');
        return false;
    }
    async function learnOne() {
        var st = learnLoadState();
        if (!st) { finishRun('state', '学习计划不可用或已被清除，自动学习结束（未确认点击停止按钮）'); return; }
        manualWaitFlag = false;
        await sleep(500);
        await dismissModal();
        updateStatus('⏳ 等待内容加载...');
        var ready = await waitContentReady(CONFIG.LEARN_CONTENT_READY_WAIT);
        if (taskState.cancelled) { finishRun('stop', taskState.stopReason || '任务已取消（来源未知）'); return; }
        var type;
        if (!ready && activeTabIsVideo()) {
            finishRun('pause', '当前是视频标签，但播放器尚未就绪；保留当前项，不自动跳过');
            return;
        }
        if (!ready) {
            updateStatus('⚠️ 内容加载超时（15 秒未渲染出来），按加载失败跳过...');
            type = 'missing';
        } else {
            type = detectContentType();
        }
        var itemContext = videoUnitContext();
        var itemVideo = findVideo();
        var previousPlayer = { video: itemVideo, source: itemVideo ? (itemVideo.currentSrc || itemVideo.src || '') : '' };
        recordRunEvent('item', 'v1.0.8 处理内容：类型=' + type + '，标签「' + contentTabKey(currentContentTab()) + '」');
        var done = true;

        if (type === 'video') {
            done = await learnVideoItem();
        } else if (type === 'doc') {
            done = await learnDocItem();
        } else {
            logDebug('learn', '视频与文档模式：跳过 ' + type);
            updateStatus('⏭ 视频与文档模式：跳过非视频内容，寻找下一个视频或文档...');
            done = true;
        }
        if (taskState.cancelled || !done) {
            finishRun(taskState.cancelled ? 'stop' : 'pause', taskState.cancelled
                ? (taskState.stopReason || '任务取消：来源未知')
                : ('自动暂停：' + (taskState.lastStatus || '当前内容处理未完成')));
            return;
        }
        st.lastType = type;
        learnSaveState(st);
        // 平台可能在播放循环中、完成等待中或刚结束等待时自行跳转。
        // 此时重新处理当前页面，绝不再点击一次“下一项”。
        if (done === 'navigated' || contentUnitChanged(itemContext, videoUnitContext())) {
            if (done !== 'navigated') followCurrentContent(itemContext);
            if (!await waitForSwitchedPlayer(previousPlayer)) {
                finishRun('pause', taskState.lastStatus || '切换后播放器未就绪');
                return;
            }
            await learnOne();
            return;
        }
        // 即便类型识别/页面渲染异常，也不能跳过仍在播放或等待弹题的视频。
        var remainingVideo = findVideo();
        if (!manualWaitFlag && activeTabIsVideo() && (!remainingVideo || !remainingVideo.ended)) {
            recordRunEvent('video-guard', '视频尚未真正结束，继续处理当前项，不进入下一标签');
            await learnOne();
            return;
        }
        var ok = await goNext();
        if (!ok) { finishRun('navigation', '导航结束：' + (taskState.lastStatus || '未能确认下一项')); return; }
        await learnOne();
    }
    async function learnChapter() {
        if (!/\/learn\//.test(location.pathname) && !/\/spoc\/learn\//.test(location.pathname)) {
            updateStatus('⚠️ 自动学习只在新版学习页可用（请先进入课程学习页的某个内容）');
            return;
        }
        var autoNext = document.querySelector('input.j-autoNext');
        if (autoNext && autoNext.checked) { realClick(autoNext); updateStatus('已关闭平台自带的“自动播放下一集”'); }

        learnSaveState({ running: true, course: location.pathname.replace(/\/content\/\d+.*$/, '') || location.pathname, term: new URL(location.href).searchParams.get('tid') || '', lastType: null });
        setFloatVisible(true);
        logDebug('learn', '🚀 手动开始自动学习，课程=' + location.pathname.slice(0, 60));
        updateStatus('🚀 自动学习开始：视频依次播放，文档自动翻页，其他内容跳过...');
        await learnOne();
    }
    function resumeLearn() {
        var st = learnLoadState();
        if (!st) return;
        if ((st.course && (location.pathname.replace(/\/content\/\d+.*$/, '').replace(/\/+$/, '') !== st.course.replace(/\/+$/, ''))) ||
            (st.term && new URL(location.href).searchParams.get('tid') && st.term !== new URL(location.href).searchParams.get('tid'))) {
            recordRunEvent('course', '课程路径改变，取消旧课程的自动续跑');
            learnClearState(); return;
        }
        setFloatVisible(true);
        runGuarded(learnOne, true);
    }


    var manualWaitFlag = false;

    function createFloatNextBtn() {
        if (document.getElementById('mar-float-next')) return;
        var btn = document.createElement('button');
        btn.id = 'mar-float-next';
        btn.textContent = '下一节';
        btn.title = '立即进入下一个内容（视频/文档/富文本都适用）';
        btn.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:999999;padding:10px 20px;font-size:14px;color:#fff;background:#e86e4f;border:none;border-radius:20px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.3);display:none;';
        btn.addEventListener('click', function () {
            if (!taskState.running) return;
            manualWaitFlag = true;
            updateStatus('⏩ 已请求进入下一个内容...');
        });
        document.body.appendChild(btn);
    }

    function setFloatVisible(v) {
        var b = document.getElementById('mar-float-next');
        if (b) b.style.display = v ? 'block' : 'none';
    }

  const DEFAULT_LLM_CONFIG = {
    enabled: false,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    apiKey: "",
    temperature: 0.7,
    timeout: 30000,
    webSearch: false,
    searchMode: "smart",
  };

  const LLM_PROVIDER_PRESETS = {
    openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
    deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
    glm: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" },
    qwen: { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-turbo" },
    kimi: { label: "Kimi (月之暗面)", baseUrl: "https://api.moonshot.cn/v1/chat/completions", model: "moonshot-v1-8k" },
    mimo: { label: "Mimo", baseUrl: "https://api.mimo.com/v1/chat/completions", model: "mimo-default" },
    custom: { label: "自定义", baseUrl: "", model: "" },
  };

  function encryptApiKey(k) {
    return k ? btoa(unescape(encodeURIComponent(k))).split("").reverse().join("") : "";
  }
  function decryptApiKey(k) {
    if (!k) return "";
    try { return decodeURIComponent(escape(atob(k.split("").reverse().join("")))); }
    catch (e) { return ""; }
  }

  function getLlmConfig() {
    const saved = GM_getValue("mooc_merged_llm_config_v1", null);
    const cfg = saved ? Object.assign({}, DEFAULT_LLM_CONFIG, saved) : Object.assign({}, DEFAULT_LLM_CONFIG);
    cfg.apiKey = decryptApiKey(cfg.apiKey);
    return cfg;
  }
  function saveLlmConfig(cfg) {
    const out = Object.assign({}, cfg);
    out.apiKey = encryptApiKey(out.apiKey || "");
    GM_setValue("mooc_merged_llm_config_v1", out);
  }

  function getConfig() {
    return Object.assign({blankSeparator:"，", autoSubmit:true}, GM_getValue("mooc_merged_quiz_config_v1", {}));
  }
  function saveConfig(cfg) { GM_setValue("mooc_merged_quiz_config_v1", cfg); }

  function log(msg) { updateStatus(msg); }
  function escapeHtml(s) { return escHtml(s); }
  const QUIZ_SELECTORS = {
    questionItem: ".u-questionItem",
    questionTitle: ".qaDescription .j-richTxt, .j-title .j-richTxt, .j-richTxt",
    radioOption: "input[type=radio].u-tbi, input[type=radio]",
    checkboxOption: "input[type=checkbox].u-tbi, input[type=checkbox]",
    optionText: ".optionCnt.f-richEditorText, .optionCnt",
    optionLabel: "label.u-tbl, label",
    blankInput: "input[type=text].j-blank, input[type=text]",
    fillBlankTextarea: ".inputArea textarea.j-textarea, .inputArea textarea.inputtxt, .m-FillBlank textarea, .inputArea textarea",
    textarea: "textarea.j-textarea, textarea, [contenteditable=true].ql-editor",
    submitBtn: "a.j-submit, a.j-submitBtn",
  };

  function isJudgeOption(optEl) {
    return !!(optEl && (optEl.querySelector(".u-icon-correct") || optEl.querySelector(".u-icon-wrong")));
  }

  function detectQuestionType(itemEl) {
    const fillTextareas = itemEl.querySelectorAll(QUIZ_SELECTORS.fillBlankTextarea);
    if (fillTextareas.length) return "2";
    if (itemEl.classList && itemEl.classList.contains("m-FillBlank")) return "2";

    const textareas = itemEl.querySelectorAll(QUIZ_SELECTORS.textarea);
    const checkboxes = itemEl.querySelectorAll(QUIZ_SELECTORS.checkboxOption);
    const radios = itemEl.querySelectorAll(QUIZ_SELECTORS.radioOption);
    const blanks = itemEl.querySelectorAll(QUIZ_SELECTORS.blankInput);

    if (textareas.length && !radios.length && !checkboxes.length) return "4";
    if (checkboxes.length) return "1";
    if (radios.length) {
      const opts = Array.from(itemEl.querySelectorAll(QUIZ_SELECTORS.optionText));
      if (opts.length === 2 && opts.every(isJudgeOption)) return "3";
      const optTexts = opts.map(function (e) { return (e.innerText || "").replace(/[\s 　]+/g, "").toLowerCase(); });
      const isJudgeByText = optTexts.length === 2 &&
        optTexts.every(function (t) { return /^(对|错|正确|错误|是|否|true|false)$/.test(t); });
      if (isJudgeByText) return "3";
      return "0";
    }
    if (blanks.length) return "2";
    return null;
  }

  function extractOptionTexts(itemEl, type) {
    const opts = Array.from(itemEl.querySelectorAll(QUIZ_SELECTORS.optionText));
    if (type === "3") {
      return opts.map(function (e) {
        if (e.querySelector(".u-icon-correct")) return "对";
        if (e.querySelector(".u-icon-wrong")) return "错";
        return (e.innerText || "").trim();
      });
    }
    return opts.map(function (e) { return (e.innerText || "").trim(); });
  }

  function resolveChoiceTexts(text, options) {
    if (!options.length || !options.every(o => /^[A-Z]$/i.test(o.trim()))) return options;
    const mapping = {};
    const pattern = /(?:^|[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f])([A-Z])[、.．：:]\s*([\s\S]*?)(?=(?:[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f]+[A-Z][、.．：:])|$)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      mapping[match[1]] = match[2].replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").trim();
    }
    if (!options.every(o => mapping[o.trim().toUpperCase()])) return options;
    return options.map(o => mapping[o.trim().toUpperCase()]);
  }

  function parseQuiz() {
    const items = document.querySelectorAll(QUIZ_SELECTORS.questionItem);
    const questions = [];
    items.forEach(function (item, idx) {
      const titleEl = item.querySelector(QUIZ_SELECTORS.questionTitle);
      const text = titleEl ? (titleEl.innerText || "").trim() : "";
      if (!text || !isVisible(item)) return;
      const type = detectQuestionType(item);
      if (!type) return;
      let options = extractOptionTexts(item, type);
      if (type === "0" || type === "1") options = resolveChoiceTexts(text, options);
      questions.push({ index: idx, el: item, text: text, type: type, options: options });
    });
    return questions;
  }

  function triggerInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getOptionItems(itemEl) {
    let lis = itemEl.querySelectorAll(".j-choicebox ul.choices > li");
    if (!lis.length) lis = itemEl.querySelectorAll("ul.choices > li");
    if (!lis.length) lis = itemEl.querySelectorAll(".j-choicebox > ul > li, .j-choicebox li");
    if (!lis.length) {
      const allLi = itemEl.querySelectorAll("li");
      lis = Array.from(allLi).filter(function (li) {
        return li.querySelector("input[type=radio], input[type=checkbox]");
      });
    }
    return lis;
  }

  function fillQuizAnswer(q, answer) {
    const item = q.el;
    if (q.type === "0") {
      const letter = (answer.match(/[A-Z]/i) || ["A"])[0].toUpperCase();
      const idx = letter.charCodeAt(0) - 65;
      const lis = getOptionItems(item);
      const li = lis[idx];
      if (!li) return false;
      const label = li.querySelector("label.u-tbl, label");
      const radio = li.querySelector("input[type=radio]");
      if (label) { label.click(); return true; }
      if (radio) { radio.click(); return true; }
      return false;
    }
    if (q.type === "1") {
      const raw = String(answer).trim().replace(/^(?:答案|正确答案)\s*[:：]\s*/, "");
      if (!/^[A-Za-z\s,，、;；/|\[\]()（）]+$/.test(raw)) {
        log("  [多选] 答案格式异常，未修改选项");
        return false;
      }
      const letters = [...new Set(raw.toUpperCase().match(/[A-Z]/g) || [])];
      const lis = Array.from(getOptionItems(item));
      if (!letters.length || !lis.length || letters.some(L => L.charCodeAt(0) - 65 >= lis.length)) return false;
      const boxes = lis.map(li => li.querySelector("input[type=checkbox]"));
      if (boxes.some(b => !b || b.disabled)) return false;
      const wanted = new Set(letters.map(L => L.charCodeAt(0) - 65));
      log("  [多选] 同步选项：" + letters.join(","));
      lis.forEach(function (li, i) {
        if (boxes[i].checked === wanted.has(i)) return;
        const label = li.querySelector("label.u-tbl, label");
        if (label) label.click(); else boxes[i].click();
      });
      return boxes.every((b, i) => b.checked === wanted.has(i));
    }
    if (q.type === "2") {
      let parts = String(answer).split("###").map(function (s) { return s.trim(); });
      let blanks = item.querySelectorAll(QUIZ_SELECTORS.blankInput);
      if (!blanks.length) blanks = item.querySelectorAll(QUIZ_SELECTORS.fillBlankTextarea);
      if (!blanks.length) blanks = item.querySelectorAll(".m-FillBlank textarea");
      if (!blanks.length) blanks = item.querySelectorAll(".inputArea textarea");
      if (!blanks.length) blanks = item.querySelectorAll(".inputArea input");
      if (!blanks.length) blanks = item.querySelectorAll('textarea[name="inputtxt"]');
      log("  [填空] 找到 " + blanks.length + " 个填空元素");
      if (!blanks.length || parts.some(p => !p)) return false;
      if (blanks.length === 1) {
        const configured = getConfig().blankSeparator;
        const separator = (typeof configured === "string" ? configured : "，")
          .replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        parts = [parts.join(separator)];
      } else if (parts.length !== blanks.length) {
        log("  [填空] 答案数量与输入框数量不一致，未填写，避免漏填或错位");
        return false;
      }
      let hit = 0;
      blanks.forEach(function (b, i) {
        if (!parts[i]) return;
        log("  [填空] Q" + (i + 1) + " 目标值=\"" + parts[i] + "\" tag=" + b.tagName + " disabled=" + b.disabled);
        try { b.focus(); } catch (e) {}
        if (b.disabled) {
          b.disabled = false;
          b.removeAttribute("disabled");
        }
        var wrapper = b.closest && b.closest(".u-baseinputui-disable");
        if (wrapper) wrapper.classList.remove("u-baseinputui-disable");
        b.value = "";
        var filled = false;
        try {
          b.focus();
          document.execCommand("selectAll", false, null);
          filled = document.execCommand("insertText", false, parts[i]);
        } catch (e) { filled = false; }
        log("  [填空] execCommand=" + filled + " value=\"" + b.value + "\"");
        if (!filled || !b.value) {
          try {
            var proto = b.tagName === "TEXTAREA"
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(b, parts[i]);
          } catch (e) { b.value = parts[i]; }
          b.dispatchEvent(new Event("input", { bubbles: true }));
          b.dispatchEvent(new Event("change", { bubbles: true }));
          log("  [填空] fallback 设值后 value=\"" + b.value + "\"");
        }
        triggerInput(b);
        b.dispatchEvent(new Event("blur", { bubbles: true }));
        if (b.value === parts[i]) hit++;
      });
      return hit === blanks.length;
    }
    if (q.type === "3") {
      const lis = getOptionItems(item);
      const wantTrue = /(对|正确|是|true)/i.test(answer);
      for (let i = 0; i < lis.length; i++) {
        const li = lis[i];
        const optCnt = li.querySelector(QUIZ_SELECTORS.optionText) || li;
        const isTrueOpt =
          !!optCnt.querySelector(".u-icon-correct") ||
          /^(对|正确|是|true)$/i.test((optCnt.innerText || "").trim());
        const isWrongOpt =
          !!optCnt.querySelector(".u-icon-wrong") ||
          /^(错|错误|否|false)$/i.test((optCnt.innerText || "").trim());
        const match = wantTrue ? isTrueOpt : isWrongOpt;
        if (match) {
          const label = li.querySelector("label.u-tbl, label");
          const radio = li.querySelector("input[type=radio]");
          if (label) label.click();
          else if (radio) radio.click();
          else return false;
          return true;
        }
      }
      return false;
    }
    return false;
  }

  function waitForReplayButton(timeoutMs, isStale) {
    const start = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        if (isStale && isStale()) { resolve(false); return; }
        const replay = document.querySelector("a.j-replay");
        const visible = replay && replay.offsetParent !== null && getComputedStyle(replay).display !== "none";
        if (visible) { resolve(true); return; }
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(poll, 500);
      })();
    });
  }

  function hasReplayButton() {
    const replay = document.querySelector("a.j-replay");
    return !!(replay && replay.offsetParent !== null && getComputedStyle(replay).display !== "none");
  }

  function handleQuizPreparePhase(isStale) {
    return new Promise(function (resolve) {
      var prepareEl = document.querySelector(".j-prepare");
      if (!prepareEl || prepareEl.classList.contains("f-dn") || getComputedStyle(prepareEl).display === "none") {
        resolve();
        return;
      }
      log("[测试题] 检测到准备阶段，自动勾选并开始...");
      var agreeCheck = prepareEl.querySelector(".j-agree, #agreeCheck");
      if (agreeCheck && !agreeCheck.checked) {
        agreeCheck.click();
      }
      var startBtn = prepareEl.querySelector(".j-startBtn");
      if (startBtn) {
        startBtn.click();
        log("[测试题] 已点击开始测验");
      }
      var pollCount = 0;
      var poll = setInterval(function () {
        if (isStale && isStale()) { clearInterval(poll); resolve(); return; }
        pollCount++;
        var doingEl = document.querySelector(".j-doing");
        var hasQuestions = doingEl && !doingEl.classList.contains("f-dn") &&
          doingEl.querySelector(".u-questionItem");
        if (hasQuestions || pollCount > 20) {
          clearInterval(poll);
          resolve();
        }
      }, 500);
    });
  }

  function parseTestListPage() {
    var items = document.querySelectorAll(".u-quizHwListItem");
    var quizzes = [];
    items.forEach(function (item, idx) {
      var nameEl = item.querySelector(".j-name");
      var name = nameEl ? nameEl.textContent.trim() : "";
      var btn = item.querySelector(".j-quizBtn");
      var btnText = btn ? btn.textContent.trim() : "";
      if (btnText.indexOf("前往测验") === -1) return;
      var ansul = item.querySelector(".ansul, .j-ansul");
      var hasScoreTable = !!ansul && ansul.querySelectorAll("li").length > 1; // 至少有表头+1条记录
      quizzes.push({
        index: idx, name: name, btn: btn, item: item,
        done: hasScoreTable,
      });
    });
    return quizzes;
  }

  const LLM_PROMPTS = {
    "0": "你是答题助手。下面是一道单选题，请根据最后提供的选项列表，只回复该列表中的一个大写选项字母（A/B/C/D...），不要返回题干内部的字母标签，不要任何解释。",
    "1": "你是答题助手。下面是一道多选题，请根据最后提供的选项列表，只回复该列表中的大写选项字母序列（如 ABD），不要返回题干内部的字母标签，不要任何解释。",
    "2": "你是答题助手。下面是一道填空题，可能有多个空。请用 ### 分隔每个空的答案，不要任何解释。例：北京###上海###广州",
    "3": "你是答题助手。下面是一道判断题，请只回复『对』或『错』，不要任何解释。",
  };

  function getSearchCountByType(questionType) {
    const countMap = { "0": 2, "1": 3, "2": 3, "3": 2, "4": 5, "5": 5, "6": 5, "7": 5 };
    return countMap[questionType] || 3;
  }

  const WEB_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };

  function stripHtml(html) {
    return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
  }

  function searchBing(query, count) {
    return new Promise(function (resolve) {
      var url = "https://cn.bing.com/search?q=" + encodeURIComponent(query) + "&count=" + count;
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        headers: WEB_HEADERS,
        timeout: 10000,
        onload: function (res) {
          try {
            var html = res.responseText;
            var results = [];
            var itemRegex = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
            var match;
            while ((match = itemRegex.exec(html)) !== null && results.length < count) {
              var item = match[1];
              var titleMatch = item.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
              if (!titleMatch) continue;
              var title = stripHtml(titleMatch[2]);
              var itemUrl = titleMatch[1];
              var snippetMatch = item.match(/<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
                || item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
              var snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";
              if (title) results.push({ title: title, snippet: snippet, url: itemUrl });
            }
            log("[WebSearch] Bing 搜索完成，获取 " + results.length + " 条结果");
            resolve(results);
          } catch (e) {
            log("[WebSearch] Bing 搜索解析失败: " + e.message);
            resolve([]);
          }
        },
        ontimeout: function () { log("[WebSearch] Bing 搜索超时"); resolve([]); },
        onerror: function () { log("[WebSearch] Bing 搜索失败"); resolve([]); }
      });
    });
  }

  var CRAWL_BLACKLIST = [
    "zhihu.com", "xiaohongshu.com", "weibo.com", "weixin.qq.com",
    "douyin.com", "tiktok.com", "bilibili.com", "csdn.net",
  ];

  function isBlacklisted(url) {
    return CRAWL_BLACKLIST.some(function (domain) { return url.indexOf(domain) !== -1; });
  }

  function extractContent(html) {
    var cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
    var mainSelectors = ["article", "main", '[role="main"]', ".article-content", ".post-content", ".content", "#content", "body"];
    for (var i = 0; i < mainSelectors.length; i++) {
      var sel = mainSelectors[i];
      var regex;
      if (sel.charAt(0) === "[") {
        regex = new RegExp("<\\w+[^>]*" + sel.slice(1, -1) + "[^>]*>([\\s\\S]*?)<\\/\\w+>", "i");
      } else if (sel.charAt(0) === "." || sel.charAt(0) === "#") {
        var tag = "\\w+";
        var val = sel.slice(1);
        var attr = sel.charAt(0) === "#" ? 'id="' + val + '"' : 'class="[^"]*\\b' + val + '\\b[^"]*"';
        regex = new RegExp("<" + tag + "[^>]*" + attr + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
      } else {
        regex = new RegExp("<" + sel + "[^>]*>([\\s\\S]*?)<\\/" + sel + ">", "i");
      }
      var m = cleaned.match(regex);
      if (m && m[1]) {
        var text = stripHtml(m[1]);
        if (text.length > 50) return text.slice(0, 3000);
      }
    }
    return stripHtml(cleaned).slice(0, 3000);
  }

  function crawlWebPage(url) {
    return new Promise(function (resolve) {
      if (!url || isBlacklisted(url)) { resolve(""); return; }
      GM_xmlhttpRequest({
        method: "GET", url: url, headers: WEB_HEADERS, timeout: 15000,
        onload: function (res) { try { resolve(extractContent(res.responseText)); } catch (e) { resolve(""); } },
        ontimeout: function () { resolve(""); },
        onerror: function () { resolve(""); }
      });
    });
  }

  function crawlTopResults(searchResults, maxCrawl) {
    maxCrawl = maxCrawl || 2;
    var targets = searchResults.filter(function (r) { return r.url && !isBlacklisted(r.url); }).slice(0, maxCrawl);
    if (!targets.length) return Promise.resolve([]);
    return Promise.all(targets.map(function (r) {
      return crawlWebPage(r.url).then(function (content) {
        return { url: r.url, title: r.title, content: content };
      });
    }));
  }

  function checkConfidence(answer) {
    if (!answer) return false;
    var lowConfidenceWords = ["不确定", "可能", "也许", "大概", "或许", "不太清楚", "无法确定", "不太确定", "没有把握", "不太了解", "不太熟悉", "不太明确", "不太肯定", "not sure", "maybe", "uncertain", "unclear", "i think", "might be", "possibly", "probably"];
    var lowerAnswer = answer.toLowerCase();
    return lowConfidenceWords.some(function (word) { return lowerAnswer.includes(word); });
  }

  function judgeRelevance(cfg, question, results) {
    return new Promise(function (resolve) {
      if (!cfg.apiKey || !cfg.baseUrl) {
        resolve({ relevant: true, info: results.map(function (r) { return r.title + ": " + r.snippet; }).join("\n") });
        return;
      }
      var resultsText = results.map(function (r, i) { return (i + 1) + ". " + r.title + ": " + r.snippet; }).join("\n");
      var prompt = "你是一个搜索结果筛选助手。请判断以下搜索结果与题目是否相关。如果相关，请提取有用信息；如果不相关，请说明原因。\n\n题目：" + question + "\n\n搜索结果：\n" + resultsText + "\n\n请返回 JSON 格式：{\"relevant\": true/false, \"info\": \"提取的相关信息\"}";
      var payload = JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: "你是一个搜索结果筛选助手。只返回 JSON 格式的结果，不要添加其他内容。" },
          { role: "user", content: prompt }
        ],
        max_tokens: 500
      });
      GM_xmlhttpRequest({
        method: "POST", url: cfg.baseUrl,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
        data: payload, timeout: 15000,
        onload: function (res) {
          try {
            var data = JSON.parse(res.responseText);
            var rawAnswer = "";
            if (data.choices && data.choices.length > 0) { rawAnswer = data.choices[0].message.content.trim(); }
            var jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              var parsed = JSON.parse(jsonMatch[0]);
              log("[WebSearch] 相关性判断: " + (parsed.relevant ? "相关" : "不相关"));
              resolve(parsed);
            } else {
              resolve({ relevant: true, info: results.map(function (r) { return r.title + ": " + r.snippet; }).join("\n") });
            }
          } catch (e) {
            resolve({ relevant: true, info: results.map(function (r) { return r.title + ": " + r.snippet; }).join("\n") });
          }
        },
        ontimeout: function () { resolve({ relevant: true, info: results.map(function (r) { return r.title + ": " + r.snippet; }).join("\n") }); },
        onerror: function () { resolve({ relevant: true, info: results.map(function (r) { return r.title + ": " + r.snippet; }).join("\n") }); }
      });
    });
  }

  function callLlmRaw(cfg, question, type, options, searchInfo) {
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) return Promise.reject(new Error("LLM 配置不完整"));
    const systemPrompt = LLM_PROMPTS[type] || LLM_PROMPTS["0"];
    let userContent = (searchInfo ? "参考资料：\n" + searchInfo + "\n\n" : "") + "题目：" + question;
    if (options && options.length) {
      userContent += "\n\n选项：\n" + options.map(function (o, i) {
        return String.fromCharCode(65 + i) + ". " + o;
      }).join("\n");
    }
    const payload = JSON.stringify({
      model: cfg.model, temperature: cfg.temperature,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
    });
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: "POST", url: cfg.baseUrl,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
        data: payload, timeout: cfg.timeout,
        onload: function (resp) {
          if (resp.status < 200 || resp.status >= 300) {
            reject(new Error("LLM HTTP " + resp.status));
            return;
          }
          try {
            const data = JSON.parse(resp.responseText);
            const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
              (data.content && data.content[0] && data.content[0].text) || "";
            if (!text) { reject(new Error("LLM 返回为空")); return; }
            resolve(text.trim());
          } catch (e) { reject(new Error("LLM 响应解析失败：" + e.message)); }
        },
        onerror: function () { reject(new Error("LLM 网络错误")); },
        ontimeout: function () { reject(new Error("LLM 超时")); },
      });
    });
  }

  function askLLM(question, type, options) {
    var cfg = getLlmConfig();
    if (!cfg.enabled) return Promise.reject(new Error("LLM 未启用"));
    if (!cfg.webSearch) { return callLlmRaw(cfg, question, type, options); }
    var shouldSearch = cfg.searchMode === "always";
    if (!shouldSearch && cfg.searchMode === "smart") {
      return callLlmRaw(cfg, question, type, options).then(function (answer) {
        if (!checkConfidence(answer)) { log("[WebSearch] 直接回答置信度高，跳过搜索"); return answer; }
        log("[WebSearch] 直接回答置信度低，触发联网搜索");
        return doSearchAndAnswer(cfg, question, type, options);
      }).catch(function () { return doSearchAndAnswer(cfg, question, type, options); });
    }
    return doSearchAndAnswer(cfg, question, type, options);
  }

  function doSearchAndAnswer(cfg, question, type, options) {
    var searchCount = getSearchCountByType(type);
    return searchBing(question, searchCount).then(function (searchResults) {
      if (searchResults.length === 0) { return callLlmRaw(cfg, question, type, options); }
      return judgeRelevance(cfg, question, searchResults).then(function (relevance) {
        if (!relevance.relevant || !relevance.info) { return callLlmRaw(cfg, question, type, options); }
        return crawlTopResults(searchResults, 2).then(function (crawled) {
          var fullInfo = relevance.info;
          crawled.forEach(function (page) {
            if (page.content && page.content.length > 50) {
              fullInfo += "\n\n【网页原文 · " + page.title + "】\n" + page.content.slice(0, 1500);
            }
          });
          return callLlmRaw(cfg, question, type, options, fullInfo);
        });
      });
    }).catch(function () { return callLlmRaw(cfg, question, type, options); });
  }

  GM_addStyle(String.raw`#icourse-popup-viewer{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100000;width:720px;max-height:80vh;background:#1d1d1d;color:#eee;border-radius:8px;font-family:monospace;font-size:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);display:flex;flex-direction:column;}#icourse-popup-viewer .pv-head{padding:10px 12px;background:#2a2a2a;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;}#icourse-popup-viewer .pv-body{padding:10px 12px;overflow:auto;flex:1;}#icourse-popup-viewer pre{background:#000;padding:8px;border-radius:4px;white-space:pre-wrap;word-break:break-all;margin:6px 0;}#icourse-popup-viewer .pv-actions button{background:#444;color:#eee;border:none;padding:4px 10px;border-radius:3px;cursor:pointer;margin-left:6px;}#icourse-popup-viewer.llm-panel{width:520px;}#icourse-popup-viewer.llm-panel .pv-body{padding:16px 18px;font-family:'Segoe UI','PingFang SC',sans-serif;}.llm-row{display:grid;grid-template-columns:90px 1fr;align-items:center;gap:10px;margin-bottom:12px;}.llm-row label.k{color:#aaa;font-size:12px;}.llm-row .v{display:flex;align-items:center;gap:6px;}.llm-row .v input[type=text],.llm-row .v input[type=password],.llm-row .v input[type=number],.llm-row .v select{flex:1;min-width:0;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:4px;padding:5px 8px;font-size:12px;font-family:inherit;outline:none;}.llm-row .v input:focus,.llm-row .v select:focus{border-color:#4fc;}.llm-row .v input::placeholder{color:#555;}.llm-row.dual{grid-template-columns:90px 1fr 90px 1fr;}.llm-row .eye{background:#333;color:#ccc;border:1px solid #444;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;}.llm-row .eye:hover{background:#4a4a4a;color:#fff;}.llm-switch{display:flex;align-items:center;justify-content:space-between;background:#262626;padding:10px 14px;border-radius:6px;margin-bottom:14px;border-left:3px solid #555;transition:border-color .2s;}.llm-switch.on{border-left-color:#4f4;}.llm-switch .lbl{font-size:13px;color:#eee;}.llm-switch .sub{font-size:11px;color:#888;margin-top:2px;}.llm-switch input{display:none;}.llm-switch .track{width:40px;height:22px;background:#444;border-radius:11px;position:relative;cursor:pointer;transition:background .2s;}.llm-switch .track::after{content:'';position:absolute;left:2px;top:2px;width:18px;height:18px;background:#ddd;border-radius:50%;transition:left .2s,background .2s;}.llm-switch.on .track{background:#2ea043;}.llm-switch.on .track::after{left:20px;background:#fff;}#cf-test-out{margin-top:6px;font-size:12px;min-height:18px;}#cf-test-out.ok{color:#4f4;}#cf-test-out.err{color:#f66;}#cf-test-out.pending{color:#aaa;}#cf-toast{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:#2ea043;color:#fff;padding:6px 14px;border-radius:4px;font-size:12px;opacity:0;transition:opacity .2s,top .2s;pointer-events:none;}#cf-toast.show{opacity:1;top:46px;}`);

  function showLlmConfigPanel() {
    const old = document.getElementById("icourse-popup-viewer");
    if (old) old.remove();
    const cfg = getLlmConfig();
    const viewer = document.createElement("div");
    viewer.id = "icourse-popup-viewer";
    viewer.classList.add("llm-panel");
    viewer.style.position = "fixed";
    const presetOptions = Object.keys(LLM_PROVIDER_PRESETS).map(function (k) {
      const lbl = LLM_PROVIDER_PRESETS[k].label || k;
      return "<option value='" + k + "'" + (k === cfg.provider ? " selected" : "") + ">" + escapeHtml(lbl) + "</option>";
    }).join("");
    viewer.innerHTML =
      "<div class=pv-head><span>LLM 配置</span><div class=pv-actions>" +
      "<button id=pv-reset title='恢复当前预设默认值'>恢复默认</button>" +
      "<button id=pv-test>测试连接</button>" +
      "<button id=pv-save style='background:#2ea043;'>保存</button>" +
      "<button id=pv-close>关闭</button></div></div>" +
      "<div id=cf-toast>已保存 ✓</div><div class=pv-body>" +
      "<div id=cf-switch class='llm-switch" + (cfg.enabled ? " on" : "") + "'>" +
      "<div><div class=lbl>启用 LLM 答题</div><div class=sub>关闭后测验不会调用 LLM</div></div>" +
      "<div class=track></div><input type=checkbox id=cf-enabled" + (cfg.enabled ? " checked" : "") + "></div>" +
      "<div id=ws-switch class='llm-switch" + (cfg.webSearch ? " on" : "") + "'>" +
      "<div><div class=lbl>启用联网搜索</div><div class=sub>LLM 回答前先联网搜索相关资料</div></div>" +
      "<div class=track></div><input type=checkbox id=cf-webSearch" + (cfg.webSearch ? " checked" : "") + "></div>" +
      "<div class=llm-row><label class=k>搜索模式</label><div class=v><select id=cf-searchMode>" +
      "<option value='always'" + (cfg.searchMode === "always" ? " selected" : "") + ">始终搜索</option>" +
      "<option value='smart'" + (cfg.searchMode === "smart" ? " selected" : "") + ">智能搜索</option>" +
      "</select></div></div>" +
      "<div class=llm-row><label class=k>预设</label><div class=v><select id=cf-provider>" + presetOptions + "</select></div></div>" +
      "<div class=llm-row><label class=k>Base URL</label><div class=v>" +
      "<input id=cf-baseUrl type=text placeholder='https://api.example.com/v1/chat/completions' value='" + escapeHtml(cfg.baseUrl) + "'></div></div>" +
      "<div class=llm-row><label class=k>Model</label><div class=v>" +
      "<input id=cf-model type=text placeholder='gpt-4o-mini / deepseek-chat' value='" + escapeHtml(cfg.model) + "'></div></div>" +
      "<div class=llm-row><label class=k>API Key</label><div class=v>" +
      "<input id=cf-apiKey type=password placeholder='sk-...' value='" + escapeHtml(cfg.apiKey) + "'>" +
      "<button class=eye id=cf-eye title='显示/隐藏'>👁</button></div></div>" +
      "<div class='llm-row dual'>" +
      "<label class=k>Temperature</label><div class=v>" +
      "<input id=cf-temperature type=number step=0.1 min=0 max=2 value='" + escapeHtml(String(cfg.temperature)) + "'></div>" +
      "<label class=k>Timeout</label><div class=v>" +
      "<input id=cf-timeout type=number min=1000 step=1000 value='" + escapeHtml(String(cfg.timeout)) + "'></div></div>" +
      "<div id=cf-test-out></div></div>";
    document.body.appendChild(viewer);

    const $ = function (id) { return document.getElementById(id); };
    const swEl = $("cf-switch");
    const enabledEl = $("cf-enabled");
    swEl.addEventListener("click", function (e) {
      if (e.target.tagName === "INPUT") return;
      enabledEl.checked = !enabledEl.checked;
      swEl.classList.toggle("on", enabledEl.checked);
    });
    var wsEl = $("ws-switch");
    var webSearchEl = $("cf-webSearch");
    wsEl.addEventListener("click", function (e) {
      if (e.target.tagName === "INPUT") return;
      webSearchEl.checked = !webSearchEl.checked;
      wsEl.classList.toggle("on", webSearchEl.checked);
    });
    $("cf-provider").addEventListener("change", function (e) {
      const p = LLM_PROVIDER_PRESETS[e.target.value];
      if (p && p.baseUrl) $("cf-baseUrl").value = p.baseUrl;
      if (p && p.model) $("cf-model").value = p.model;
    });
    $("cf-eye").addEventListener("click", function () {
      const el = $("cf-apiKey");
      el.type = el.type === "password" ? "text" : "password";
    });
    $("pv-reset").onclick = function () {
      const p = LLM_PROVIDER_PRESETS[$("cf-provider").value];
      if (p) { $("cf-baseUrl").value = p.baseUrl || ""; $("cf-model").value = p.model || ""; }
      $("cf-temperature").value = DEFAULT_LLM_CONFIG.temperature;
      $("cf-timeout").value = DEFAULT_LLM_CONFIG.timeout;
      $("cf-test-out").className = "pending"; $("cf-test-out").textContent = "已按预设恢复（未保存）";
    };
    function readForm() {
      const tRaw = parseFloat($("cf-temperature").value);
      const toRaw = parseInt($("cf-timeout").value, 10);
      return {
        enabled: $("cf-enabled").checked, provider: $("cf-provider").value,
        baseUrl: $("cf-baseUrl").value.trim(), model: $("cf-model").value.trim(),
        apiKey: $("cf-apiKey").value.trim(),
        temperature: isNaN(tRaw) ? 0.7 : tRaw, timeout: isNaN(toRaw) ? 30000 : toRaw,
        webSearch: $("cf-webSearch").checked, searchMode: $("cf-searchMode").value,
      };
    }
    $("pv-close").onclick = function () { viewer.remove(); };
    $("pv-save").onclick = function () {
      saveLlmConfig(readForm()); log("LLM 配置已保存");
      const toast = $("cf-toast"); toast.classList.add("show");
      setTimeout(function () { viewer.remove(); }, 700);
    };
    $("pv-test").onclick = function () {
      const out = $("cf-test-out"); out.className = "pending"; out.textContent = "测试中...";
      const tempCfg = Object.assign({}, readForm(), { enabled: true });
      const t0 = Date.now();
      callLlmRaw(tempCfg, "1+1=?", "0", ["0", "1", "2", "3"]).then(
        function (ans) { out.className = "ok"; out.textContent = "✓ 返回：" + ans + "  ·  " + (Date.now() - t0) + " ms"; },
        function (err) { out.className = "err"; out.textContent = "✗ " + err.message; },
      );
    };
  }

    function createFloatingPanel() {
        if (document.getElementById('mooc-auto-review-panel')) return;
        injectStyles();
        var panel = document.createElement('div');
        panel.id = 'mooc-auto-review-panel';
        panel.innerHTML = `
          <div id="mar-header"><span id="mar-title"><span class="mar-dot"></span>MOOC 助手</span><span id="mar-minimize" title="最小化">−</span></div>
          <div id="mar-main">
            <div id="mar-tabs">
              <button class="mar-tab" data-tab="auto">自动学习</button>
              <button class="mar-tab" data-tab="quiz">测验</button>
              <button class="mar-tab" data-tab="log">日志</button>
              <button class="mar-tab" data-tab="settings">设置</button>
            </div>
            <div id="mar-body">
              <div class="mar-pane" data-pane="auto">
                <button id="mar-learn-start" class="mar-btn">开始自动学习（视频＋文档）</button>
                <button id="mar-learn-probe" class="mar-btn">页面 DOM 诊断</button>
                <div class="mar-field"><span class="mar-label">自动学习说明</span><span class="mar-hint">从视频当前位置继续播放，视频真正结束后直接跳转；平台已自动切换时接着处理当前项；文档、PDF、PPT 自动翻页，每页约 1 秒。讨论、独立测验和其他内容跳过。视频内弹题自动处理，答题后自动点击“继续学习”（含答错情况）。</span></div>
              </div>
              <div class="mar-pane" data-pane="quiz">
                <button id="mar-quiz-start" class="mar-btn">开始测验（只做选择、填空）</button>
                <button id="mar-quiz-preview" class="mar-btn">预览读取到的题目</button>
                <button id="mar-quiz-llm" class="mar-btn">LLM 配置</button>
                <div class="mar-field"><span class="mar-label">自选题模式</span><span class="mar-hint">手动进入要处理的测验后开始；只做单选、多选、判断和填空，跳过简答、论述。旧版测验列表页沿用逐个处理未完成测验的方式。新页面如无法识别，请进入实际答题页并使用题目预览检查。</span></div>
                <div class="mar-field"><label class="mar-label" for="mar-blank-separator">多空分隔符</label><input id="mar-blank-separator" type="text" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ddd;border-radius:8px"><span class="mar-hint">默认中文逗号“，”，修改后自动保存。可输入空格、顿号等；输入 \\n 表示换行；留空直接拼接。仅用于多个答案共用一个输入框。</span></div>
                <div class="mar-field"><label><input id="mar-quiz-submit" type="checkbox"> 答完后自动提交</label><span class="mar-hint">沿用原自选题模式，默认开启。若存在跳过题、失败题或未确认填写成功，只填不交，留你检查。</span></div>
              </div>
              <div class="mar-pane" data-pane="log"><button id="mar-run-history" class="mar-btn">查看运行记录（刷新后保留）</button><button id="mar-log-copy" class="mar-btn">复制日志</button><button id="mar-log-clear" class="mar-btn">清空日志</button><div id="mar-log-box" class="mar-log-box">（暂无日志）</div></div>
              <div class="mar-pane" data-pane="settings">
                <div class="mar-field"><span class="mar-label">视频倍速：<span id="mar-rate-now"></span></span><input id="mar-rate" type="range" min="0.5" max="3" step="0.25"><span class="mar-hint">用于自动学习的视频播放。</span></div>
                <button id="mar-llm-config" class="mar-btn">LLM 配置</button>
                <button id="mar-copy-unlock" class="mar-btn mar-toggle">解除复制限制：关</button>
              </div>
            </div>
            <div id="mar-foot"><button id="mar-stop" class="mar-btn">停止当前操作</button><div id="mar-status">就绪</div></div>
          </div>`;
        document.body.appendChild(panel);
        statusEl = document.getElementById('mar-status');
        panel.querySelectorAll('.mar-tab').forEach(function (button) {
            button.addEventListener('click', function () { switchTab(button.dataset.tab); });
        });
        switchTab('auto');
        var minimized = false;
        document.getElementById('mar-minimize').onclick = function () {
            minimized = !minimized;
            document.getElementById('mar-main').style.display = minimized ? 'none' : '';
            this.textContent = minimized ? '+' : '−';
        };
        var dragging = false, sx, sy, sl, st;
        document.getElementById('mar-header').addEventListener('mousedown', function (e) {
            if (e.target.id === 'mar-minimize') return;
            dragging = true; sx = e.clientX; sy = e.clientY;
            var rect = panel.getBoundingClientRect(); sl = rect.left; st = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            panel.style.left = (sl + e.clientX - sx) + 'px';
            panel.style.top = (st + e.clientY - sy) + 'px'; panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', function () { dragging = false; });
        document.getElementById('mar-learn-start').onclick = function () { runGuarded(learnChapter); };
        document.getElementById('mar-quiz-start').onclick = function () { runGuarded(runSelectedQuiz); };
        document.getElementById('mar-quiz-preview').onclick = previewQuiz;
        document.getElementById('mar-learn-probe').onclick = probeLearningDom;
        document.getElementById('mar-quiz-llm').onclick = showLlmConfigPanel;
        document.getElementById('mar-llm-config').onclick = showLlmConfigPanel;
        document.getElementById('mar-log-copy').onclick = copyDebugLogs;
        document.getElementById('mar-run-history').onclick = showRunHistory;
        document.getElementById('mar-log-clear').onclick = clearDebugLogs;
        document.getElementById('mar-copy-unlock').onclick = toggleCopyUnlock;
        updateCopyUnlockButton();
        var rate = document.getElementById('mar-rate');
        rate.value = loadVideoRate();
        document.getElementById('mar-rate-now').textContent = loadVideoRate() + 'x';
        rate.oninput = function () {
            var value = parseFloat(rate.value); saveVideoRate(value); applyVideoRate(findVideo());
            document.getElementById('mar-rate-now').textContent = value + 'x';
        };
        var separator = document.getElementById('mar-blank-separator');
        separator.value = getConfig().blankSeparator;
        separator.oninput = function () { var c = getConfig(); c.blankSeparator = separator.value; saveConfig(c); };
        var submit = document.getElementById('mar-quiz-submit');
        submit.checked = getConfig().autoSubmit;
        submit.onchange = function () { var c = getConfig(); c.autoSubmit = submit.checked; saveConfig(c); };
        document.getElementById('mar-stop').onclick = requestStop;
        setButtonsRunning(false);
    }

    async function runGuarded(fn, resumed) {
        if (taskState.running) { updateStatus('请先停止当前操作或等待完成'); return; }
        taskState.running = true; taskState.cancelled = false;
        taskState.stopReason = ''; taskState.outcomeRecorded = false;
        setButtonsRunning(true);
        var name = fn === learnChapter || fn === learnOne ? '自动学习' : '测验';
        recordRunEvent(resumed ? 'resume' : 'start', (resumed ? '页面刷新后恢复' : '开始') + name + '（v1.0.8）');
        if (resumed) updateStatus('▶ 正在恢复自动学习，从播放器当前进度继续...');
        try {
            await fn();
            if (!taskState.outcomeRecorded) {
                if (taskState.cancelled) finishRun('stop', taskState.stopReason || '任务取消：来源未知');
                else if (name === '自动学习') finishRun('end', '自动学习流程已返回，' + (taskState.lastStatus || '请检查运行记录'));
                else recordRunEvent('quiz-end', '测验处理结束：' + (taskState.lastStatus || '已返回'));
            }
        } catch (e) {
            finishRun(e && e.__cancelled ? 'cancel' : 'error', e && e.__cancelled
                ? (e.stopReason || e.message)
                : '运行异常：' + (e && e.message || String(e)));
        } finally {
            taskState.running = false; taskState.cancelled = false;
            setButtonsRunning(false); setFloatVisible(false);
        }
    }


    function previewQuiz() {
        var names = {'0':'单选','1':'多选','2':'填空','3':'判断','4':'简答（跳过）'};
        var data = parseQuiz().map(function (q) {
            return {题序:q.index + 1,题型:names[q.type] || '其他（跳过）',题干:q.text,选项:q.options,
                输入框数:q.el.querySelectorAll('input[type=text],textarea').length};
        });
        showTextOverlay('题目预览（只读，不答题）', JSON.stringify(data, null, 2));
    }

    function probeLearningDom() {
        var tabs = Array.from(document.querySelectorAll('[role="tab"]')).map(function (e) {
            return {文字:cleanText(e.textContent),选中:e.getAttribute('aria-selected')};
        });
        showTextOverlay('页面 DOM 诊断', JSON.stringify({路径:location.pathname,类型:detectContentType(),
            视频:!!findVideo(),文档:!!findDocViewer(),标签:tabs,题目数:parseQuiz().length}, null, 2));
    }
    function ensureQuizActive(url) {
        if (taskState.cancelled) throw makeCancelError();
        if (url && location.href !== url) throw new Error('页面已切换，停止当前测验');
    }

    async function prepareSelectedQuiz() {
        ensureQuizActive();
        await handleQuizPreparePhase(function () { return taskState.cancelled; });
        ensureQuizActive();
    }

    function findQuizSubmit() {
        var selectors = QUIZ_SELECTORS.submitBtn + ', button';
        return Array.from(document.querySelectorAll(selectors)).find(function (button) {
            return !button.closest('#mooc-auto-review-panel, #icourse-popup-viewer') &&
                isVisible(button) && !button.disabled && /^(提交|提交答案|提交测验|交卷|提交试卷)$/.test(cleanText(button.textContent));
        });
    }

    async function solveSelectedQuiz() {
        await prepareSelectedQuiz();
        if (hasReplayButton()) { updateStatus('当前测验已有重做按钮，按原模式跳过'); return 'done'; }
        var pageUrl = location.href;
        var all = parseQuiz();
        var questions = all.filter(function (q) { return ['0','1','2','3'].includes(q.type); });
        if (!questions.length) { updateStatus('未读取到选择、填空题，请先进入实际答题页面并查看题目预览'); return 'unreadable'; }
        var cfg = getLlmConfig();
        if (!cfg.enabled || !cfg.apiKey) throw new Error('请先打开 LLM 配置，填写 API Key 并启用 LLM 答题');
        var filled = 0;
        log('自选题模式：读取 ' + all.length + ' 题，处理 ' + questions.length + ' 题');
        for (var i = 0; i < questions.length; i++) {
            ensureQuizActive(pageUrl);
            var q = questions[i];
            updateStatus('测验：正在处理 ' + (i + 1) + '/' + questions.length + ' 题');
            try {
                var answer = await askLLM(q.text, q.type, q.options);
                ensureQuizActive(pageUrl);
                if (!document.contains(q.el)) throw new Error('题目已更新，停止填写');
                if (fillQuizAnswer(q, answer)) { filled++; log('第 ' + (q.index + 1) + ' 题已填写'); }
                else log('第 ' + (q.index + 1) + ' 题未确认填写成功，请检查');
            } catch (e) {
                ensureQuizActive(pageUrl);
                log('第 ' + (q.index + 1) + ' 题失败：' + (e && e.message || e));
            }
            await sleep(800);
        }
        ensureQuizActive(pageUrl);
        if (!getConfig().autoSubmit || filled !== questions.length || questions.length !== all.length) {
            updateStatus('已填 ' + filled + '/' + questions.length + ' 题，未自动提交，请检查并手动提交');
            return 'review';
        }
        var button = findQuizSubmit();
        if (!button) { updateStatus('已完成填写，未找到提交按钮，请手动提交'); return 'review'; }
        button.click();
        await sleep(500);
        ensureQuizActive(pageUrl);
        var confirm = document.querySelector('.m-dialog a.j-left, .m-dialog .u-btn-primary');
        if (confirm && isVisible(confirm) && /^(确定|确认|提交|确定提交)$/.test(cleanText(confirm.textContent))) confirm.click();
        var ok = await waitForReplayButton(15000, function () { return taskState.cancelled || location.href !== pageUrl; });
        ensureQuizActive(pageUrl);
        updateStatus(ok ? '✅ 测验已提交' : '提交结果尚未确认，请检查页面');
        return ok ? 'done' : 'review';
    }

    async function runSelectedQuiz() {
        if (location.hash.indexOf('/learn/testlist') === -1) { await solveSelectedQuiz(); return; }
        var pending = parseTestListPage().filter(function (q) { return !q.done; });
        if (!pending.length) { updateStatus('当前测验列表没有待完成的测验'); return; }
        var listHash = location.hash;
        for (var i = 0; i < pending.length; i++) {
            ensureQuizActive();
            var current = parseTestListPage().find(function (q) { return q.name === pending[i].name && !q.done; });
            if (!current) continue;
            updateStatus('进入测验：' + current.name);
            current.btn.click();
            if (!await waitFor(function () { return location.hash.indexOf('/learn/quiz') !== -1; }, 15000)) {
                throw new Error('测验页面未打开，请手动进入后再开始');
            }
            await sleep(1500);
            var result = await solveSelectedQuiz();
            if (result !== 'done') return; // 留在需要检查的题目页，不丢弃答案。
            ensureQuizActive();
            location.hash = listHash;
            await waitFor(function () { return !!document.querySelector('.u-quizHwListItem'); }, 15000);
            await sleep(1000);
        }
        updateStatus('✅ 当前列表的测验处理结束');
    }
    function init() {
        applyCopyUnlock(isCopyUnlockOn());
        createFloatingPanel(); createFloatNextBtn(); initRunDiagnostics(); resumeLearn();
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(init, 1000);
    else window.addEventListener('load', function () { setTimeout(init, 1000); });
})();
