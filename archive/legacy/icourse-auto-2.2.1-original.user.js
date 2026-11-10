// ==UserScript==
// @name         中国大学MOOC 自动完成助手
// @namespace    icourse-auto
// @version      2.2.1
// @description  自动完成课程任务点
// @icon         https://gips0.baidu.com/it/u=2907094647,3504094747&fm=3030&app=3030&size=re3,2&q=75&n=0&g=4n&f=JPEG&fmt=auto&maxorilen2heic=2000000?s=18863C724531DB22077D8446000080F3
// @match        *://www.icourse163.org/learn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      www.icourse163.org
// @connect      cn.bing.com
// @connect      api.deepseek.com
// @connect      api.moonshot.cn
// @connect      api.openai.com
// @connect      api.mimo.com
// @connect      dashscope.aliyuncs.com
// @connect      open.bigmodel.cn
// @run-at       document-end
// @license MIT
// ==/UserScript==

(function () {
  "use strict";

  // ─── 配置 ───────────────────────────────────────────────────────────────────

  const DEFAULT_CONFIG = {
    videoSpeed: 1,
    docWaitTime: 4,
    taskInterval: 2,
    skipTypes: [],
    autoStart: false,
    includeDone: false,
    loopVideos: false,
    skipVideo: false,
    quizOnly: false,
  };

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
    const saved = GM_getValue("icourse_llm_config", null);
    const cfg = saved ? Object.assign({}, DEFAULT_LLM_CONFIG, saved) : Object.assign({}, DEFAULT_LLM_CONFIG);
    cfg.apiKey = decryptApiKey(cfg.apiKey);
    return cfg;
  }
  function saveLlmConfig(cfg) {
    const out = Object.assign({}, cfg);
    out.apiKey = encryptApiKey(out.apiKey || "");
    GM_setValue("icourse_llm_config", out);
  }

  function getConfig() {
    const saved = GM_getValue("icourse_config", null);
    return saved ? Object.assign({}, DEFAULT_CONFIG, saved) : { ...DEFAULT_CONFIG };
  }

  function saveConfig(cfg) {
    GM_setValue("icourse_config", cfg);
  }

  // ─── 工具函数 ────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function yield$() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  function getCsrfKey() {
    const m = document.cookie.match(/(?:^|;\s*)NTESSTUDYSI=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const sm = s.textContent.match(/csrfKey\s*[=:]\s*["']([^"']+)["']/);
      if (sm) return sm[1];
    }
    return "";
  }

  function rpcRequest(action, body) {
    return new Promise((resolve, reject) => {
      const csrfKey = getCsrfKey();
      GM_xmlhttpRequest({
        method: "POST",
        url: "https://www.icourse163.org/web/j/" + action + "?csrfKey=" + csrfKey,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": location.href,
        },
        data: body,
        onload(res) {
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            reject(new Error("JSON parse error: " + res.responseText.slice(0, 100)));
          }
        },
        onerror(err) { reject(err); },
      });
    });
  }

  function fetchTaskList(termId) {
    return rpcRequest(
      "courseBean.getLastLearnedMocTermDto.rpc",
      "termId=" + termId
    ).then(data => {
      const chapters = (data && data.result && data.result.mocTermDto && data.result.mocTermDto.chapters) || [];
      const units = [];
      for (const ch of chapters) {
        for (const lesson of (ch.lessons || [])) {
          for (const unit of (lesson.units || [])) {
            unit._chapterName = ch.name || "";
            unit._lessonName = lesson.name || "";
            units.push(unit);
          }
        }
      }
      return units;
    });
  }

  // ─── 导航 ────────────────────────────────────────────────────────────────────

  function buildTaskUrl(unit) {
    const courseDto = unsafeWindow.courseDto || {};
    const termDto = unsafeWindow.termDto || {};
    const shortName = courseDto.shortName || "";
    const courseId = courseDto.id || "";
    const termId = termDto.id || "";
    return "/learn/" + shortName + "-" + courseId + "?tid=" + termId +
      "#/learn/content?type=detail&id=" + unit.lessonId + "&cid=" + unit.id;
  }

  function navigateToUnit(unit) {
    const url = buildTaskUrl(unit);
    const hashPart = url.split("#")[1];
    if (hashPart) {
      location.hash = "#" + hashPart;
    } else {
      location.href = url;
    }
  }

  function waitForElement(selector, timeout) {
    timeout = timeout || 15000;
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const timer = setTimeout(function () {
        observer.disconnect();
        reject(new Error("Timeout waiting for " + selector));
      }, timeout);
      const observer = new MutationObserver(function () {
        const found = document.querySelector(selector);
        if (found) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  function waitForContentLoad(unit) {
    if (unit.contentType === 1) {
      return waitForElement("video", 20000);
    }
    return waitForElement(".unit-study-box, .textbook-box, .rich-text-box, #j-unit-study-box", 15000)
      .catch(function () { return sleep(3000); });
  }

  // ─── 任务处理器 ──────────────────────────────────────────────────────────────

  function handleVideo(unit, config, onDone) {
    waitForElement("video", 20000).then(function (video) {
      video.playbackRate = config.videoSpeed;
      video.muted = true;
      video.volume = 0;

      const duration = unit.durationInSeconds || 600;
      const timeoutMs = (duration / config.videoSpeed + 30) * 1000;
      const timeoutId = setTimeout(function () {
        log("视频超时，强制切换");
        quizObserver.disconnect();
        video.removeEventListener("pause", onPause);
        onDone();
      }, timeoutMs);

      video.addEventListener("ended", function () {
        clearTimeout(timeoutId);
        quizObserver.disconnect();
        video.removeEventListener("pause", onPause);
        onDone();
      }, { once: true });

      let pauseDebounce = 0;
      function onPause() {
        if (video.ended) return;
        clearTimeout(pauseDebounce);
        pauseDebounce = setTimeout(function () {
          if (video.paused && !video.ended) {
            log("视频被暂停 t=" + Math.round(video.currentTime) + "，恢复播放");
            video.play().catch(function () { });
          }
        }, 500);
      }
      video.addEventListener("pause", onPause);

      const quizObserver = new MutationObserver(function () {
        const container = document.querySelector("#j-anchorContainer");
        if (!container || !container.offsetParent) return;
        const submitBtn = container.querySelector("a.j-submit");
        const contBtn = container.querySelector("a.j-continue");
        if (contBtn && contBtn.offsetParent) {
          contBtn.click();
          log("anchor 题：点击继续学习");
          return;
        }
        if (submitBtn && submitBtn.offsetParent) {
          const radios = container.querySelectorAll("input[type=radio]");
          const checkboxes = container.querySelectorAll("input[type=checkbox]");
          if (radios.length && ![...radios].some(r => r.checked)) {
            radios[0].click();
            log("anchor 题：选择 A 选项");
          } else if (checkboxes.length && ![...checkboxes].some(c => c.checked)) {
            checkboxes[0].click();
            log("anchor 题：勾选第一项");
          }
          submitBtn.click();
          log("anchor 题：点击提交");
        }
      });
      quizObserver.observe(document.body, { childList: true, subtree: true });

      const startFromZero = function () {
        try { video.currentTime = 0; } catch (e) { }
        video.play().catch(function () { });
      };
      if (config.loopVideos) {
        if (video.readyState >= 1) {
          startFromZero();
        } else {
          video.addEventListener("loadedmetadata", startFromZero, { once: true });
          video.load();
        }
      } else {
        video.play().catch(function () { });
      }

    }).catch(function (err) {
      log("等待视频元素失败: " + err.message);
      onDone();
    });
  }

  function handleDocument(unit, config, onDone) {
    waitForContentLoad(unit).then(function () {
      return sleep(config.docWaitTime * 1000);
    }).then(function () {
      onDone();
    }).catch(function () {
      sleep(config.docWaitTime * 1000).then(onDone);
    });
  }

  function handleRichText(unit, config, onDone) {
    handleDocument(unit, config, onDone);
  }

  // ─── 测试题解析 ──────────────────────────────────────────────────────────────

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

  function parseQuiz() {
    const items = document.querySelectorAll(QUIZ_SELECTORS.questionItem);
    const questions = [];
    items.forEach(function (item, idx) {
      const titleEl = item.querySelector(QUIZ_SELECTORS.questionTitle);
      const text = titleEl ? (titleEl.innerText || "").trim() : "";
      if (!text) return;
      const type = detectQuestionType(item);
      if (!type) return;
      const options = extractOptionTexts(item, type);
      questions.push({ index: idx, el: item, text: text, type: type, options: options });
    });
    return questions;
  }

  // ─── 测试题填答 ──────────────────────────────────────────────────────────────

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
      const letters = (answer.toUpperCase().match(/[A-Z]/g) || []);
      if (!letters.length) return false;
      const lis = getOptionItems(item);
      log("  [多选] 找到 " + lis.length + " 个选项，目标: " + letters.join(","));
      let hit = 0;
      letters.forEach(function (L) {
        const i = L.charCodeAt(0) - 65;
        const li = lis[i];
        if (!li) return;
        const box = li.querySelector("input[type=checkbox]");
        if (box && !box.checked) {
          const label = li.querySelector("label.u-tbl, label");
          if (label) label.click(); else box.click();
          hit++;
        }
      });
      return hit > 0;
    }
    if (q.type === "2") {
      const parts = answer.split("###").map(function (s) { return s.trim(); });
      let blanks = item.querySelectorAll(QUIZ_SELECTORS.blankInput);
      if (!blanks.length) blanks = item.querySelectorAll(QUIZ_SELECTORS.fillBlankTextarea);
      if (!blanks.length) blanks = item.querySelectorAll(".m-FillBlank textarea");
      if (!blanks.length) blanks = item.querySelectorAll(".inputArea textarea");
      if (!blanks.length) blanks = item.querySelectorAll(".inputArea input");
      if (!blanks.length) blanks = item.querySelectorAll('textarea[name="inputtxt"]');
      log("  [填空] 找到 " + blanks.length + " 个填空元素");
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
        b.dispatchEvent(new Event("blur", { bubbles: true }));
        hit++;
      });
      return hit > 0;
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
    if (q.type === "4" || q.type === "5" || q.type === "6" || q.type === "7") {
      const ta = item.querySelector(QUIZ_SELECTORS.textarea);
      if (!ta) return false;
      if (ta.tagName === "TEXTAREA") {
        ta.value = answer;
        triggerInput(ta);
      } else {
        ta.innerHTML = "<p>" + escapeHtml(answer).replace(/\n/g, "<br>") + "</p>";
        triggerInput(ta);
      }
      return true;
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

  // 点击提交后自动确认弹窗（"确定"按钮）
  function clickSubmitConfirm() {
    setTimeout(function () {
      var confirmBtn = document.querySelector(".m-dialog a.j-left, .m-dialog .u-btn-primary");
      if (confirmBtn) { confirmBtn.click(); log("[测试题] 已自动确认提交弹窗"); }
    }, 500);
  }

  function doQuiz(unit, onDone, isStale) {
    isStale = isStale || function () { return false; };
    const questions = parseQuiz();
    log("[测试题] " + unit.name + " — 解析到 " + questions.length + " 道题");
    if (!questions.length) {
      log("[测试题] 解析失败，跳过");
      onDone();
      return;
    }

    let filled = 0;
    let index = 0;

    function next() {
      if (isStale()) { log("[测试题] 已切到其他任务，停止处理 " + unit.name); return; }
      if (index >= questions.length) {
        if (filled === 0) {
          log("[测试题] 全部题目 LLM 失败或填答失败，不提交");
          onDone();
          return;
        }
        const btn = document.querySelector(QUIZ_SELECTORS.submitBtn);
        if (!btn) {
          log("[测试题] 未找到提交按钮，跳过");
          onDone();
          return;
        }
        log("[测试题] 已填 " + filled + "/" + questions.length + " 道，点击提交");
        btn.click();
        clickSubmitConfirm();
        waitForReplayButton(15000, isStale).then(function (ok) {
          if (isStale()) return;
          log(ok ? "[测试题] 提交完成（重做按钮已出现）" : "[测试题] 提交后 15s 内未确认，继续下一项");
          onDone();
        });
        return;
      }
      const q = questions[index++];
      log("  Q" + index + " type=" + q.type + " text=" + q.text.slice(0, 30));
      yield$().then(function() { return askLLM(q.text, q.type, q.options); }).then(function (ans) {
        if (isStale()) return;
        if (!document.contains(q.el)) {
          log("  Q" + index + " 节点已 detached，放弃");
          sleep(300).then(next);
          return;
        }
        const ok = fillQuizAnswer(q, ans);
        if (ok) {
          filled++;
          log("  Q" + index + " (type=" + q.type + ") → " + ans.slice(0, 40));
        } else {
          log("  Q" + index + " 填答失败：" + ans.slice(0, 40));
        }
        sleep(800).then(next);
      }, function (err) {
        if (isStale()) return;
        log("  Q" + index + " LLM 失败：" + err.message);
        sleep(500).then(next);
      });
    }
    next();
  }

  function hasReplayButton() {
    const replay = document.querySelector("a.j-replay");
    return !!(replay && replay.offsetParent !== null && getComputedStyle(replay).display !== "none");
  }

  function doQuizChoiceOnly(unit, onDone, isStale) {
    isStale = isStale || function () { return false; };
    const all = parseQuiz();
    const questions = all.filter(function (q) {
      return q.type === "0" || q.type === "1" || q.type === "3" || q.type === "2";
    });
    const skipped = all.length - questions.length;
    log("[测试题专项] " + unit.name + " — 解析 " + all.length + " 题，做 " + questions.length + " 题" +
      (skipped ? "（跳过 " + skipped + " 道简答/论述）" : ""));
    if (!questions.length) {
      log("[测试题专项] 无可做题目，跳过");
      onDone();
      return;
    }

    let filled = 0;
    let index = 0;

    function next() {
      if (isStale()) { log("[测试题专项] 已中断，停止处理 " + unit.name); return; }
      if (index >= questions.length) {
        if (filled === 0) {
          log("[测试题专项] 全部 LLM 失败或填答失败，不提交");
          onDone();
          return;
        }
        const btn = document.querySelector(QUIZ_SELECTORS.submitBtn);
        if (!btn) {
          log("[测试题专项] 未找到提交按钮，跳过");
          onDone();
          return;
        }
        log("[测试题专项] 已填 " + filled + "/" + questions.length + " 道，点击提交");
        btn.click();
        clickSubmitConfirm();
        waitForReplayButton(15000, isStale).then(function (ok) {
          if (isStale()) return;
          log(ok ? "[测试题专项] 提交完成" : "[测试题专项] 提交后 15s 内未确认，继续下一项");
          onDone();
        });
        return;
      }
      const q = questions[index++];
      yield$().then(function() { return askLLM(q.text, q.type, q.options); }).then(function (ans) {
        if (isStale()) return;
        if (!document.contains(q.el)) {
          log("  Q" + index + " 节点已 detached，放弃");
          sleep(300).then(next);
          return;
        }
        const ok = fillQuizAnswer(q, ans);
        if (ok) {
          filled++;
          log("  Q" + index + " (type=" + q.type + ") → " + ans.slice(0, 40));
        } else {
          log("  Q" + index + " 填答失败：" + ans.slice(0, 40));
        }
        sleep(800).then(next);
      }, function (err) {
        if (isStale()) return;
        log("  Q" + index + " LLM 失败：" + err.message);
        sleep(500).then(next);
      });
    }
    next();
  }

  // ─── 测试题（contentType=5） ────────────────────────────────────────────────

  let __lastQuizFirstText = "";

  function getFirstQuestionText() {
    const first = document.querySelector(QUIZ_SELECTORS.questionItem);
    if (!first) return "";
    const t = first.querySelector(QUIZ_SELECTORS.questionTitle);
    return t ? (t.innerText || "").trim() : "";
  }

  function waitForNewQuiz(prevText, timeoutMs) {
    const start = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        const cur = getFirstQuestionText();
        if (cur && cur !== prevText) { resolve(cur); return; }
        if (Date.now() - start > timeoutMs) { resolve(cur); return; }
        setTimeout(poll, 400);
      })();
    });
  }

  // 处理 quiz 页面的"开始测验"准备阶段
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

  function handleQuiz(unit, config, onDone, sid, mooc) {
    const isStale = function () { return mooc && mooc.isStale && mooc.isStale(sid); };
    waitForContentLoad(unit).then(function () {
      if (isStale()) return null;
      return handleQuizPreparePhase(isStale);
    }).then(function () {
      if (isStale()) return null;
      return waitForNewQuiz(__lastQuizFirstText, 8000);
    }).then(function (curText) {
      if (isStale()) return;
      if (curText) __lastQuizFirstText = curText;
      if (config.quizOnly) {
        if (hasReplayButton()) {
          log("[仅做测试题] " + unit.name + " — 已有重做按钮，跳过");
          onDone();
          return;
        }
        doQuizChoiceOnly(unit, onDone, isStale);
      } else {
        doQuiz(unit, onDone, isStale);
      }
    }).catch(function (err) {
      if (isStale()) return;
      log("[测试题] 异常：" + (err && err.message || err));
      onDone();
    });
  }

  // ─── 讨论题解析与回帖 ────────────────────────────────────────────────────────

  const DISCUSS_SELECTORS = {
    topicContainer: ".j-post",
    topicTitle: ".j-post h3.j-title.title, .j-post .j-title",
    topicBody: ".j-post .content.j-content.f-richEditorText",
    replyList: ".j-reply-all .j-data-list",
    replyItem: ".m-detailInfoItem",
    replyContent: ".m-detailInfoItem .j-content.f-richEditorText",
    replyAuthor: ".m-detailInfoItem .j-name",
    replyBtn: "a.replyBtn.j-replyBtn",
    editor: ".rich-editor .ql-editor[contenteditable=true]",
    submitBtn: "a.j-edit-btn.editbtn",
  };

  const REPLY_TAILS = [
    "，我也是这样想的。",
    "，受教了。",
    "，深有同感。",
    "，学习了。",
    "，赞同这个观点。",
    "，思路很清晰。",
    "，确实如此。",
    "，分析得很到位。",
    "，谢谢分享。",
    "，很有启发。",
  ];

  function pickTail() {
    return REPLY_TAILS[Math.floor(Math.random() * REPLY_TAILS.length)];
  }

  function stripTrailingPunct(s) {
    return s.replace(/[。！？!?\.\s]+$/g, "");
  }

  function parseDiscussTopic() {
    const titleEl = document.querySelector(DISCUSS_SELECTORS.topicTitle);
    const bodyEl = document.querySelector(DISCUSS_SELECTORS.topicBody);
    const title = titleEl ? (titleEl.innerText || "").trim() : "";
    const body = bodyEl ? (bodyEl.innerText || "").trim() : "";
    if (!title && !body) return "";
    return (title + "\n" + body).trim();
  }

  function findLastReply() {
    const list = document.querySelector(DISCUSS_SELECTORS.replyList);
    if (!list) return null;
    const items = list.querySelectorAll(DISCUSS_SELECTORS.replyItem);
    if (!items.length) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i].querySelector(DISCUSS_SELECTORS.replyContent);
      const text = c ? (c.innerText || "").trim() : "";
      if (text && text.length > 4) return text;
    }
    return null;
  }

  function openReplyEditor() {
    if (document.querySelector(DISCUSS_SELECTORS.editor)) return Promise.resolve(true);
    const replyBtn = document.querySelector(DISCUSS_SELECTORS.replyBtn);
    if (!replyBtn) return Promise.resolve(false);
    replyBtn.click();
    return waitForElement(DISCUSS_SELECTORS.editor, 5000).then(
      function () { return true; },
      function () { return false; },
    );
  }

  function fillEditor(text) {
    const ed = document.querySelector(DISCUSS_SELECTORS.editor);
    if (!ed) return false;
    if (ed.tagName === "TEXTAREA") {
      ed.value = text;
    } else {
      ed.innerHTML = "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>";
    }
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    ed.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // ─── 讨论题（contentType=6） ────────────────────────────────────────────────

  function handleDiscuss(unit, config, onDone, sid, mooc) {
    const isStale = function () { return mooc && mooc.isStale && mooc.isStale(sid); };
    waitForContentLoad(unit).then(function () {
      if (isStale()) return;
      return sleep(2000);
    }).then(function () {
      if (isStale()) return;
      doDiscuss(unit, onDone, isStale);
    }).catch(function (err) {
      if (isStale()) return;
      log("[讨论题] 异常：" + (err && err.message || err));
      onDone();
    });
  }

  function doDiscuss(unit, onDone, isStale) {
    isStale = isStale || function () { return false; };
    const topic = parseDiscussTopic();
    const prev = findLastReply();
    log("[讨论题] " + unit.name + (prev ? " — 复制上一回复" : " — 无回复，调用 LLM"));

    const buildAndPost = function (body) {
      if (isStale()) return;
      const finalBody = stripTrailingPunct(body) + pickTail();
      openReplyEditor().then(function (opened) {
        if (isStale()) return;
        if (!opened) {
          log("[讨论题] 无法打开回复编辑器，跳过");
          onDone();
          return;
        }
        return sleep(500).then(function () {
          if (isStale()) return;
          const ok = fillEditor(finalBody);
          if (!ok) {
            log("[讨论题] 编辑器定位失败，跳过");
            onDone();
            return;
          }
          return sleep(800).then(function () {
            if (isStale()) return;
            const btn = document.querySelector(DISCUSS_SELECTORS.submitBtn);
            if (btn) {
              btn.click();
              log("[讨论题] 已提交：" + finalBody.slice(0, 40));
            } else {
              log("[讨论题] 未找到提交按钮");
            }
            return sleep(3000).then(function () {
              if (isStale()) return;
              onDone();
            });
          });
        });
      });
    };

    if (prev) {
      buildAndPost(prev);
    } else {
      if (!topic) {
        log("[讨论题] 主题为空，跳过");
        onDone();
        return;
      }
      askLLM(topic, "4", []).then(function (ans) {
        if (isStale()) return;
        buildAndPost(ans);
      }, function (err) {
        if (isStale()) return;
        log("[讨论题] LLM 失败：" + err.message + "，跳过");
        onDone();
      });
    }
  }

  // ─── 日志 ────────────────────────────────────────────────────────────────────

  const logLines = [];
  function log(msg) {
    const time = new Date().toLocaleTimeString();
    const line = "[" + time + "] " + msg;
    logLines.push(line);
    if (logLines.length > 30) logLines.shift();
    console.log("[慕课助手]", msg);
    updateUI();
  }

  // ─── LLM 调用 ────────────────────────────────────────────────────────────────

  const LLM_PROMPTS = {
    "0": "你是答题助手。下面是一道单选题，请只回复一个大写字母（A/B/C/D...）作为答案，不要任何解释。",
    "1": "你是答题助手。下面是一道多选题，请只回复选项字母序列（如 ABD），不要任何解释。",
    "2": "你是答题助手。下面是一道填空题，可能有多个空。请用 ### 分隔每个空的答案，不要任何解释。例：北京###上海###广州",
    "3": "你是答题助手。下面是一道判断题，请只回复『对』或『错』，不要任何解释。",
    "4": "你是答题助手。下面是一道简答题，请给出准确简洁的答案，不超过 200 字，不要列点。",
    "5": "你是答题助手。下面是一道名词解释，请给出简洁定义，不超过 100 字。",
    "6": "你是答题助手。下面是一道论述题，请给出条理清晰的回答，不超过 300 字。",
    "7": "你是答题助手。下面是一道计算题，请给出解题步骤和最终答案。",
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

  function callLlmRaw(cfg, question, type, options) {
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) return Promise.reject(new Error("LLM 配置不完整"));
    const systemPrompt = LLM_PROMPTS[type] || LLM_PROMPTS["4"];
    let userContent = "题目：" + question;
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
            reject(new Error("LLM HTTP " + resp.status + ": " + (resp.responseText || "").slice(0, 200)));
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

  function callLlmRawWithSearchInfo(cfg, question, type, options, searchInfo) {
    if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) return Promise.reject(new Error("LLM 配置不完整"));
    var systemPrompt = LLM_PROMPTS[type] || LLM_PROMPTS["4"];
    var userContent = "参考资料：\n" + searchInfo + "\n\n题目：" + question;
    if (options && options.length) {
      userContent += "\n\n选项：\n" + options.map(function (o, i) { return String.fromCharCode(65 + i) + ". " + o; }).join("\n");
    }
    var payload = JSON.stringify({
      model: cfg.model, temperature: cfg.temperature,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
    });
    return new Promise(function (resolve, reject) {
      log("[LLM] 使用联网搜索结果增强回答");
      GM_xmlhttpRequest({
        method: "POST", url: cfg.baseUrl,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
        data: payload, timeout: cfg.timeout,
        onload: function (resp) {
          if (resp.status < 200 || resp.status >= 300) {
            reject(new Error("LLM HTTP " + resp.status)); return;
          }
          try {
            var data = JSON.parse(resp.responseText);
            var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
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
          return callLlmRawWithSearchInfo(cfg, question, type, options, fullInfo);
        });
      });
    }).catch(function () { return callLlmRaw(cfg, question, type, options); });
  }

  // ─── 测试列表页处理（#/learn/testlist） ────────────────────────────────────

  var CONCURRENCY_WAIT_MS = 15000;
  var QUIZ_INTERVAL_MS = 3000;
  var NAVIGATION_DELAY_MS = 3000;
  var POST_QUIZ_DELAY_MS = 5000;

  // 自选题模式：检测当前页面并处理
  function handleCurrentPage(config, sid, mooc) {
    var isStale = function () { return mooc.isStale(sid); };
    var hash = location.hash;

    // 测试列表页
    if (isTestListPage()) {
      handleTestList(config, sid, mooc);
      return;
    }

    // Quiz 页面：处理当前测验
    if (hash.indexOf("/learn/quiz") !== -1) {
      log("[当前页] 检测到 quiz 页面，开始答题");
      var m = hash.match(/id=(\d+)/);
      var quizId = m ? m[1] : "unknown";
      var unit = { name: "当前测验", contentType: 5, id: quizId };
      handleQuiz(unit, config, function () {
        log("[当前页] 答题完毕");
        mooc.state = "IDLE"; updateUI();
      }, sid, mooc);
      return;
    }

    // 内容页：尝试处理当前单元
    if (hash.indexOf("/learn/content") !== -1) {
      log("[当前页] 检测到内容页，尝试处理当前单元");
      // 从 URL 提取当前单元信息
      var cidMatch = hash.match(/cid=(\d+)/);
      var idMatch = hash.match(/id=(\d+)/);
      if (cidMatch && idMatch) {
        var unit = { name: "当前内容", contentType: 0, id: cidMatch[1], lessonId: idMatch[1] };
        // 尝试检测页面上的内容类型
        var video = document.querySelector("video");
        var quiz = document.querySelector(".u-questionItem");
        var textarea = document.querySelector("textarea, [contenteditable=true]");
        if (quiz) {
          unit.contentType = 5;
          log("[当前页] 检测到测试题，开始答题");
          handleQuiz(unit, config, function () {
            log("[当前页] 答题完毕");
            mooc.state = "IDLE"; updateUI();
          }, sid, mooc);
        } else if (video) {
          unit.contentType = 1;
          log("[当前页] 检测到视频，开始播放");
          handleVideo(unit, config, function () {
            log("[当前页] 视频处理完毕");
            mooc.state = "IDLE"; updateUI();
          });
        } else {
          log("[当前页] 未检测到可处理的内容");
          mooc.state = "IDLE"; updateUI();
        }
      } else {
        log("[当前页] 无法解析当前单元信息");
        mooc.state = "IDLE"; updateUI();
      }
      return;
    }

    log("[当前页] 无法识别当前页面类型，请切换到内容页或测试列表页");
    mooc.state = "IDLE"; updateUI();
  }

  function isTestListPage() {
    return location.hash.indexOf("/learn/testlist") !== -1;
  }

  function dismissConcurrencyPopup() {
    var popup = document.querySelector(".u-layerMoadl, .u-modal, .j-layer, .u-dialog, [class*=layer]");
    if (!popup) return false;
    var text = (popup.textContent || "") + (popup.innerText || "");
    if (text.indexOf("并发限制") === -1 && text.indexOf("稍后再试") === -1) return false;
    var okBtn = popup.querySelector(".u-layerBtnGreen, .j-okBtn, button, a[class*=btn]");
    if (okBtn) okBtn.click();
    setTimeout(function () {
      var p = document.querySelector(".u-layerMoadl, .u-modal, .j-layer");
      if (p && p.parentNode) p.parentNode.removeChild(p);
    }, 500);
    log("[并发限制] 已自动关闭弹窗");
    return true;
  }

  function waitConcurrencyClear(maxRetries) {
    maxRetries = maxRetries || 10;
    var retryCount = 0;
    return new Promise(function (resolve) {
      (function check() {
        if (retryCount >= maxRetries) { resolve(); return; }
        if (dismissConcurrencyPopup()) {
          retryCount++;
          var waitSec = Math.min(CONCURRENCY_WAIT_MS / 1000 * retryCount, 120);
          log("[并发限制] 第 " + retryCount + " 次，等待 " + waitSec + " 秒后重试...");
          sleep(waitSec * 1000).then(check);
        } else { resolve(); }
      })();
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
      // 判断是否已完成：查看展开区域是否有"有效测验成绩"表格（.ansul）
      var ansul = item.querySelector(".ansul, .j-ansul");
      var hasScoreTable = !!ansul && ansul.querySelectorAll("li").length > 1; // 至少有表头+1条记录
      quizzes.push({
        index: idx, name: name, btn: btn, item: item,
        done: hasScoreTable,
      });
    });
    return quizzes;
  }

  function getDoneQuizIds() { return GM_getValue("icourse_done_quizzes", []); }
  function markQuizDone(quizId) {
    var done = getDoneQuizIds();
    if (done.indexOf(quizId) === -1) { done.push(quizId); GM_setValue("icourse_done_quizzes", done); }
  }
  function isQuizDone(quizId) { return getDoneQuizIds().indexOf(quizId) !== -1; }

  function handleTestList(config, sid, mooc) {
    var isStale = function () { return mooc.isStale(sid); };
    var quizzes = parseTestListPage();
    var pending = quizzes.filter(function (q) { return !q.done; });
    log("[测试列表] 发现 " + quizzes.length + " 个单元测试，" +
      pending.length + " 个待完成，" + (quizzes.length - pending.length) + " 个已完成");
    if (!pending.length) {
      log("[测试列表] 所有单元测试已完成");
      mooc.state = "IDLE"; updateUI(); return;
    }
    mooc.state = "PROCESSING"; updateUI();

    var idx = 0;
    function nextQuiz() {
      if (isStale()) { log("[测试列表] 已中断"); return; }
      dismissConcurrencyPopup();
      if (idx >= pending.length) {
        log("[测试列表] 全部处理完成");
        mooc.state = "IDLE"; updateUI(); return;
      }
      var quiz = pending[idx++];
      log("[测试列表] (" + idx + "/" + pending.length + ") " + quiz.name);
      sleep(QUIZ_INTERVAL_MS).then(function () {
        if (isStale()) return;
        dismissConcurrencyPopup();
        quiz.btn.click();
        waitForQuizPage(15000, isStale).then(function (quizId) {
          if (isStale()) return;
          if (!quizId) {
            log("[测试列表] 跳转超时，跳过 " + quiz.name);
            location.hash = location.hash.replace(/\/learn\/quiz.*/, "/learn/testlist");
            sleep(NAVIGATION_DELAY_MS).then(nextQuiz); return;
          }
          log("[测试列表] 进入 quiz id=" + quizId);
          var replayBtn = document.querySelector("a.j-replay");
          var isReplayVisible = replayBtn && replayBtn.offsetParent !== null &&
            getComputedStyle(replayBtn).display !== "none";
          if (isReplayVisible) {
            log("[测试列表] " + quiz.name + " — 已有重做按钮，跳过");
            markQuizDone(quizId);
            location.hash = location.hash.replace(/\/learn\/quiz.*/, "/learn/testlist");
            sleep(NAVIGATION_DELAY_MS).then(nextQuiz); return;
          }
          waitConcurrencyClear(5).then(function () {
            if (isStale()) return;
            var unit = { name: quiz.name, contentType: 5, id: quizId };
            handleQuiz(unit, config, function () {
              markQuizDone(quizId);
              log("[测试列表] 答题完毕，等待返回");
              sleep(POST_QUIZ_DELAY_MS).then(function () {
                if (isStale()) return;
                dismissConcurrencyPopup();
                location.hash = location.hash.replace(/\/learn\/quiz.*/, "/learn/testlist");
                sleep(NAVIGATION_DELAY_MS).then(function () {
                  if (isStale()) return;
                  dismissConcurrencyPopup();
                  nextQuiz();
                });
              });
            }, sid, mooc);
          });
        });
      });
    }
    nextQuiz();
  }

  function waitForQuizPage(timeoutMs, isStale) {
    var start = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        if (isStale && isStale()) { resolve(null); return; }
        var m = location.hash.match(/\/learn\/quiz\?id=(\d+)/);
        if (m) { resolve(m[1]); return; }
        if (Date.now() - start > timeoutMs) { resolve(null); return; }
        setTimeout(poll, 300);
      })();
    });
  }

  // ─── 复制解锁 ──────────────────────────────────────────────────────────────

  function unlockCopy() {
    try {
      var w = unsafeWindow || window;
      if (w.APP) {
        if (w.APP.api && w.APP.api._permissions) { w.APP.api._permissions.copy = true; }
        if (w.APP.pdfEditPermissions) { w.APP.pdfEditPermissions.copy = true; }
        if (w.APP.session && w.APP.session._permissions) { w.APP.session._permissions.copy = true; }
      }
      if (w.fileInfo && w.fileInfo.user_acl) { w.fileInfo.user_acl.copy = true; }
    } catch (e) {}
  }

  function initCopyUnlock() {
    unlockCopy();
    setInterval(unlockCopy, 2000);
    document.addEventListener("copy", function (e) { e.stopPropagation(); }, true);
    document.addEventListener("beforecopy", function (e) { e.stopPropagation(); }, true);
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) { e.stopImmediatePropagation(); }
    }, true);
    document.addEventListener("contextmenu", function (e) { e.stopImmediatePropagation(); }, true);
    document.addEventListener("selectstart", function (e) { e.stopImmediatePropagation(); }, true);
    var lastUrl = location.href;
    var urlObserver = new MutationObserver(function () {
      if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(unlockCopy, 500); setTimeout(unlockCopy, 1500); }
    });
    urlObserver.observe(document, { subtree: true, childList: true });
  }

  // ─── 主控制器 ────────────────────────────────────────────────────────────────

  class IcourseMooc {
    constructor() {
      this.config = getConfig();
      if (this.config.skipTypes && (this.config.skipTypes.includes(5) || this.config.skipTypes.includes(6))) {
        this.config.skipTypes = this.config.skipTypes.filter(function (t) { return t !== 5 && t !== 6; });
        saveConfig(this.config);
      }
      this.state = "IDLE";
      this.tasks = [];
      this.currentIndex = 0;
      this.paused = false;
      this.sessionId = 0;
      this.pendingJumpTarget = null;
      this._refreshAfterTask = false;
    }

    isStale(sid) { return sid !== this.sessionId || this.paused; }

    async start() {
      if (this.state !== "IDLE") return;
      this.paused = false; this.pendingJumpTarget = null; this._refreshAfterTask = false;
      this.config = getConfig();
      log("开始获取任务列表...");
      this.state = "FETCHING"; updateUI();
      const termId = unsafeWindow.termDto && unsafeWindow.termDto.id;
      if (!termId) { log("错误：未找到 termId"); this.state = "IDLE"; updateUI(); return; }
      try {
        const allUnits = await fetchTaskList(termId);
        this.allUnits = allUnits;
        const cfg = this.config;
        this.tasks = allUnits.filter(function (u) {
          if (cfg.skipTypes.includes(u.contentType)) return false;
          if (cfg.quizOnly) return u.contentType === 5;
          if ((u.completePercent || 0) >= 1.0) return false;
          if (u.learnTime && u.learnTime > 0) return false;
          return true;
        });
        log("找到 " + this.tasks.length + " 个" + (cfg.quizOnly ? "测试题" : "未完成") + "任务（共 " + allUnits.length + " 个）");
        this.currentIndex = 0;
        await this._loop();
      } catch (err) {
        log("获取任务列表失败: " + err.message);
        this.state = "IDLE"; updateUI();
      }
    }

    pause() { this.paused = true; this.state = "PAUSED"; log("已暂停"); updateUI(); }

    resume() {
      if (this.state !== "PAUSED") return;
      this.paused = false;
      if (this.pendingJumpTarget) {
        const target = this.pendingJumpTarget; this.pendingJumpTarget = null;
        const idx = this.tasks.findIndex(function (u) { return u.id === target.id; });
        if (idx >= 0) { this.currentIndex = idx; this._refreshAfterTask = false; }
        else { this.tasks.splice(this.currentIndex, 0, target); this._refreshAfterTask = true; }
      }
      log("继续运行..."); this._loop();
    }

    stop() { this.paused = true; this.state = "IDLE"; this.pendingJumpTarget = null; this._refreshAfterTask = false; log("已停止"); updateUI(); }

    jumpTo(unit) {
      if (!unit) return;
      this.sessionId++; this.pendingJumpTarget = unit;
      this.paused = true; this.state = "PAUSED";
      log("[跳转] " + unit.name + " — 已导航并暂停");
      try { navigateToUnit(unit); } catch (e) { log("[跳转] 导航失败：" + e.message); }
      updateUI();
    }

    async _refreshTaskList() {
      const termId = unsafeWindow.termDto && unsafeWindow.termDto.id;
      if (!termId) throw new Error("未找到 termId");
      const allUnits = await fetchTaskList(termId);
      this.allUnits = allUnits;
      const cfg = this.config;
      this.tasks = allUnits.filter(function (u) {
        if (cfg.skipTypes.includes(u.contentType)) return false;
        if (cfg.quizOnly) return u.contentType === 5;
        if ((u.completePercent || 0) >= 1.0) return false;
        if (u.learnTime && u.learnTime > 0) return false;
        return true;
      });
      this.currentIndex = 0;
      log("[刷新] 剩余 " + this.tasks.length + " 个任务（共 " + allUnits.length + " 个）");
    }

    async _loop() {
      if (this.paused) return;
      if (this.currentIndex >= this.tasks.length) {
        if (this.config.loopVideos && !this.config.skipVideo) {
          const videos = (this.allUnits || []).filter(function (u) { return u.contentType === 1; });
          if (videos.length) { this.tasks = this.tasks.concat(videos); log("[循环] 已追加 " + videos.length + " 个视频到队列末尾"); }
          else { log("所有任务已完成！"); this.state = "IDLE"; updateUI(); return; }
        } else { log("所有任务已完成！"); this.state = "IDLE"; updateUI(); return; }
      }
      const sid = ++this.sessionId;
      const unit = this.tasks[this.currentIndex];
      log("[" + (this.currentIndex + 1) + "/" + this.tasks.length + "] " + unit.name + " (类型 " + unit.contentType + ")");
      this.state = "NAVIGATING"; updateUI();
      navigateToUnit(unit);
      await yield$(); await sleep(1500);
      if (this.isStale(sid)) return;
      this.state = "WAITING_LOAD"; updateUI();
      const self = this;
      const onDone = async function () {
        if (self.isStale(sid)) return;
        if (self._refreshAfterTask) {
          self._refreshAfterTask = false; self.state = "FETCHING"; updateUI();
          try { await self._refreshTaskList(); } catch (e) { self.currentIndex++; }
          await sleep(self.config.taskInterval * 1000);
          if (self.isStale(sid)) return; self._loop(); return;
        }
        self.currentIndex++;
        await yield$(); await sleep(self.config.taskInterval * 1000);
        if (self.isStale(sid)) return; self._loop();
      };
      this.state = "PROCESSING"; updateUI();
      if (unit.contentType === 1) {
        if (this.config.skipVideo) { log("[跳过视频] " + unit.name); onDone(); return; }
        handleVideo(unit, this.config, onDone);
      } else if (unit.contentType === 3) { handleDocument(unit, this.config, onDone); }
      else if (unit.contentType === 4) { handleRichText(unit, this.config, onDone); }
      else if (unit.contentType === 5) { handleQuiz(unit, this.config, onDone, sid, this); }
      else if (unit.contentType === 6) { handleDiscuss(unit, this.config, onDone, sid, this); }
      else { log("跳过类型 " + unit.contentType + ": " + unit.name); onDone(); }
    }
  }

  const mooc = new IcourseMooc();
  initCopyUnlock();

  // ─── 全局并发限制弹窗监控 ──────────────────────────────────────────────────

  (function initConcurrencyWatchdog() {
    var lastDismiss = 0;
    var observer = new MutationObserver(function () {
      var now = Date.now();
      if (now - lastDismiss < 1000) return;
      var popups = document.querySelectorAll(
        ".u-layerMoadl, .u-modal, .j-layer, .u-dialog, [class*=layer], [class*=modal], [class*=dialog]"
      );
      popups.forEach(function (popup) {
        var text = (popup.textContent || "") + (popup.innerText || "");
        if (text.indexOf("并发限制") === -1 && text.indexOf("稍后再试") === -1) return;
        lastDismiss = now;
        var btns = popup.querySelectorAll(".u-layerBtnGreen, .j-okBtn, button, a[class*=btn], [class*=close]");
        btns.forEach(function (b) { try { b.click(); } catch (e) {} });
        setTimeout(function () { if (popup.parentNode) popup.parentNode.removeChild(popup); }, 200);
        console.log("[慕课助手][并发限制] 全局监控已关闭弹窗");
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  })();

  // ─── UI ──────────────────────────────────────────────────────────────────────

  GM_addStyle([
    "#icourse-btn{",
    "position:fixed;bottom:20px;right:20px;z-index:99999;",
    "width:48px;height:48px;border-radius:50%;",
    "background:#e02020;color:#fff;font-size:20px;",
    "border:none;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);",
    "display:flex;align-items:center;justify-content:center;",
    "}",
    "#icourse-panel{",
    "position:fixed;left:12px;top:50%;",
    "z-index:99999;width:260px;background:rgba(20,20,20,.92);",
    "color:#eee;border-radius:8px;",
    "font-size:12px;font-family:monospace;line-height:1.6;",
    "box-shadow:0 4px 16px rgba(0,0,0,.5);",
    "}",
    "#icourse-panel .head{",
    "display:flex;align-items:center;justify-content:space-between;",
    "padding:8px 10px;cursor:move;user-select:none;",
    "background:rgba(255,255,255,.06);border-radius:8px 8px 0 0;",
    "}",
    "#icourse-panel .head h4{margin:0;color:#fff;font-size:13px;}",
    "#icourse-panel .head .btns{display:flex;gap:4px;}",
    "#icourse-panel .head .icon-btn{",
    "width:20px;height:20px;line-height:18px;text-align:center;",
    "background:transparent;color:#ccc;border:1px solid #555;",
    "border-radius:3px;cursor:pointer;font-size:12px;padding:0;",
    "}",
    "#icourse-panel .head .icon-btn:hover{background:#333;color:#fff;}",
    "#icourse-panel .body{padding:10px 12px 12px;}",
    "#icourse-panel.collapsed .body{display:none;}",
    "#icourse-panel.collapsed{width:auto;}",
    "#icourse-panel .progress{color:#4fc;margin-bottom:6px;}",
    "#icourse-panel .log-box{max-height:160px;overflow-y:auto;}",
    "#icourse-panel .log-line{border-bottom:1px solid #333;padding:2px 0;}",
    "#icourse-speed{margin-top:8px;}",
    "#icourse-speed label{color:#aaa;}",
    "#icourse-speed select{background:#333;color:#eee;border:1px solid #555;border-radius:3px;}",
    "#icourse-video-opts{margin-top:6px;display:flex;gap:10px;color:#aaa;font-size:11px;}",
    "#icourse-video-opts label{cursor:pointer;display:flex;align-items:center;gap:4px;}",
    "#icourse-video-opts input{margin:0;}",
    "#icourse-video-opts label.disabled{opacity:.4;cursor:not-allowed;}",
    "#icourse-popup-viewer{",
    "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);",
    "z-index:100000;width:720px;max-height:80vh;background:#1d1d1d;",
    "color:#eee;border-radius:8px;font-family:monospace;font-size:12px;",
    "box-shadow:0 8px 32px rgba(0,0,0,.6);display:flex;flex-direction:column;",
    "}",
    "#icourse-popup-viewer .pv-head{",
    "padding:10px 12px;background:#2a2a2a;border-radius:8px 8px 0 0;",
    "display:flex;justify-content:space-between;align-items:center;",
    "}",
    "#icourse-popup-viewer .pv-body{padding:10px 12px;overflow:auto;flex:1;}",
    "#icourse-popup-viewer pre{",
    "background:#000;padding:8px;border-radius:4px;",
    "white-space:pre-wrap;word-break:break-all;margin:6px 0;",
    "}",
    "#icourse-popup-viewer .pv-actions button{",
    "background:#444;color:#eee;border:none;padding:4px 10px;",
    "border-radius:3px;cursor:pointer;margin-left:6px;",
    "}",
    "#icourse-popup-viewer.llm-panel{width:520px;}",
    "#icourse-popup-viewer.llm-panel .pv-body{padding:16px 18px;font-family:'Segoe UI','PingFang SC',sans-serif;}",
    ".llm-row{display:grid;grid-template-columns:90px 1fr;align-items:center;gap:10px;margin-bottom:12px;}",
    ".llm-row label.k{color:#aaa;font-size:12px;}",
    ".llm-row .v{display:flex;align-items:center;gap:6px;}",
    ".llm-row .v input[type=text],.llm-row .v input[type=password],.llm-row .v input[type=number],.llm-row .v select{",
    "flex:1;min-width:0;background:#2a2a2a;color:#eee;border:1px solid #444;",
    "border-radius:4px;padding:5px 8px;font-size:12px;font-family:inherit;outline:none;",
    "}",
    ".llm-row .v input:focus,.llm-row .v select:focus{border-color:#4fc;}",
    ".llm-row .v input::placeholder{color:#555;}",
    ".llm-row.dual{grid-template-columns:90px 1fr 90px 1fr;}",
    ".llm-row .eye{background:#333;color:#ccc;border:1px solid #444;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;}",
    ".llm-row .eye:hover{background:#4a4a4a;color:#fff;}",
    ".llm-switch{display:flex;align-items:center;justify-content:space-between;background:#262626;padding:10px 14px;border-radius:6px;margin-bottom:14px;border-left:3px solid #555;transition:border-color .2s;}",
    ".llm-switch.on{border-left-color:#4f4;}",
    ".llm-switch .lbl{font-size:13px;color:#eee;}",
    ".llm-switch .sub{font-size:11px;color:#888;margin-top:2px;}",
    ".llm-switch input{display:none;}",
    ".llm-switch .track{width:40px;height:22px;background:#444;border-radius:11px;position:relative;cursor:pointer;transition:background .2s;}",
    ".llm-switch .track::after{content:'';position:absolute;left:2px;top:2px;width:18px;height:18px;background:#ddd;border-radius:50%;transition:left .2s,background .2s;}",
    ".llm-switch.on .track{background:#2ea043;}",
    ".llm-switch.on .track::after{left:20px;background:#fff;}",
    "#cf-test-out{margin-top:6px;font-size:12px;min-height:18px;}",
    "#cf-test-out.ok{color:#4f4;}",
    "#cf-test-out.err{color:#f66;}",
    "#cf-test-out.pending{color:#aaa;}",
    "#cf-toast{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:#2ea043;color:#fff;padding:6px 14px;border-radius:4px;font-size:12px;opacity:0;transition:opacity .2s,top .2s;pointer-events:none;}",
    "#cf-toast.show{opacity:1;top:46px;}",
  ].join(""));

  function buildUI() {
    const btn = document.createElement("button");
    btn.id = "icourse-btn";
    btn.textContent = "▶";
    btn.title = "慕课助手";
    document.body.appendChild(btn);

    const panel = document.createElement("div");
    panel.id = "icourse-panel";
    panel.innerHTML = [
      "<div class=head id=icourse-head>",
      "<h4>慕课自动完成助手</h4>",
      "<div class=btns>",
      "<button class=icon-btn id=icourse-tasks title=任务列表（可跳转）>📚</button>",
      "<button class=icon-btn id=icourse-llm title=LLM配置>⚙️</button>",
      "<button class=icon-btn id=icourse-help title=使用说明>❓</button>",
      "<button class=icon-btn id=icourse-min title=最小化>—</button>",
      "</div>",
      "</div>",
      "<div class=body id=icourse-body>",
      "<div class=progress id=icourse-progress>就绪</div>",
      "<div id=icourse-speed>",
      "<label>视频倍速：</label>",
      "<select id=icourse-speed-sel>",
      "<option value=1>1x</option>",
      "<option value=1.25>1.25x</option>",
      "<option value=1.5>1.5x</option>",
      "<option value=2>2x</option>",
      "</select>",
      "</div>",
      "<div id=icourse-video-opts>",
      "<label id=lbl-loop><input type=checkbox id=cf-loopVideos> 视频循环（刷时长）</label>",
      "<label id=lbl-skip><input type=checkbox id=cf-skipVideo> 跳过视频</label>",
      "<label id=lbl-quiz><input type=checkbox id=cf-quizOnly> 仅做测试题</label>",
      "</div>",
      "<div id=icourse-mode style='margin-top:6px;'>",
      "<label style='color:#aaa;'>模式：</label>",
      "<span id=icourse-mode-label style='color:#4fc;cursor:pointer;' title='点击切换模式'>未完成模式</span>",
      "</div>",
      "<div class=log-box id=icourse-log></div>",
      "</div>",
    ].join("");
    document.body.appendChild(panel);

    const uiState = GM_getValue("icourse_ui", null) || {};
    if (typeof uiState.left === "number" && typeof uiState.top === "number") {
      panel.style.left = uiState.left + "px";
      panel.style.top = uiState.top + "px";
    }
    if (uiState.collapsed) {
      panel.classList.add("collapsed");
      const mb = document.getElementById("icourse-min");
      if (mb) mb.textContent = "□";
    }

    const head = document.getElementById("icourse-head");
    let dragging = false, dragDx = 0, dragDy = 0, didDrag = false;
    head.addEventListener("mousedown", function (e) {
      if (e.target.closest(".icon-btn")) return;
      dragging = true; didDrag = false;
      const rect = panel.getBoundingClientRect();
      dragDx = e.clientX - rect.left; dragDy = e.clientY - rect.top;
      panel.style.transform = "none"; e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return; didDrag = true;
      const maxL = window.innerWidth - panel.offsetWidth;
      const maxT = window.innerHeight - panel.offsetHeight;
      panel.style.left = Math.max(0, Math.min(maxL, e.clientX - dragDx)) + "px";
      panel.style.top = Math.max(0, Math.min(maxT, e.clientY - dragDy)) + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return; dragging = false;
      if (didDrag) {
        const s = GM_getValue("icourse_ui", null) || {};
        s.left = parseInt(panel.style.left, 10);
        s.top = parseInt(panel.style.top, 10);
        GM_setValue("icourse_ui", s);
      }
    });

    const minBtn = document.getElementById("icourse-min");
    minBtn.addEventListener("click", function () {
      const collapsed = panel.classList.toggle("collapsed");
      minBtn.textContent = collapsed ? "□" : "—";
      const s = GM_getValue("icourse_ui", null) || {};
      s.collapsed = collapsed; GM_setValue("icourse_ui", s);
    });

    document.getElementById("icourse-llm").addEventListener("click", showLlmConfigPanel);
    document.getElementById("icourse-tasks").addEventListener("click", showTaskListPanel);
    document.getElementById("icourse-help").addEventListener("click", showHelpPanel);

    const speedSel = document.getElementById("icourse-speed-sel");
    speedSel.value = String(mooc.config.videoSpeed);
    speedSel.addEventListener("change", function () {
      mooc.config.videoSpeed = parseFloat(speedSel.value); saveConfig(mooc.config);
    });

    const loopEl = document.getElementById("cf-loopVideos");
    const skipEl = document.getElementById("cf-skipVideo");
    const quizEl = document.getElementById("cf-quizOnly");
    const lblLoop = document.getElementById("lbl-loop");
    const lblSkip = document.getElementById("lbl-skip");
    const lblQuiz = document.getElementById("lbl-quiz");
    const refreshDisable = function () {
      const lk = loopEl.checked, sk = skipEl.checked, qz = quizEl.checked;
      lblLoop.classList.toggle("disabled", sk || qz);
      lblSkip.classList.toggle("disabled", lk || qz);
      lblQuiz.classList.toggle("disabled", lk || sk);
      loopEl.disabled = sk || qz; skipEl.disabled = lk || qz; quizEl.disabled = lk || sk;
    };
    const hintIfRunning = function () {
      if (mooc.state !== "IDLE") { log("[提示] 当前任务队列结束后生效；如需立即应用，可刷新页面重新开始"); }
    };
    loopEl.checked = !!mooc.config.loopVideos;
    skipEl.checked = !!mooc.config.skipVideo;
    quizEl.checked = !!mooc.config.quizOnly;
    refreshDisable();
    loopEl.addEventListener("change", function () {
      mooc.config.loopVideos = loopEl.checked;
      if (loopEl.checked) { skipEl.checked = false; mooc.config.skipVideo = false; quizEl.checked = false; mooc.config.quizOnly = false; }
      saveConfig(mooc.config); refreshDisable();
      log(loopEl.checked ? "[视频循环] 开启" : "[视频循环] 关闭");
      hintIfRunning();
    });
    skipEl.addEventListener("change", function () {
      mooc.config.skipVideo = skipEl.checked;
      if (skipEl.checked) { loopEl.checked = false; mooc.config.loopVideos = false; quizEl.checked = false; mooc.config.quizOnly = false; }
      saveConfig(mooc.config); refreshDisable();
      log(skipEl.checked ? "[跳过视频] 开启" : "[跳过视频] 关闭");
      hintIfRunning();
    });
    quizEl.addEventListener("change", function () {
      mooc.config.quizOnly = quizEl.checked;
      if (quizEl.checked) { loopEl.checked = false; mooc.config.loopVideos = false; skipEl.checked = false; mooc.config.skipVideo = false; }
      saveConfig(mooc.config); refreshDisable();
      log(quizEl.checked ? "[仅做测试题] 开启" : "[仅做测试题] 关闭");
      hintIfRunning();
    });

    // 模式切换
    var currentMode = "auto"; // "auto" | "incomplete" | "quiz"
    var modeLabel = document.getElementById("icourse-mode-label");
    var MODE_LIST = [
      { key: "auto", label: "自动检测", color: "#4fc" },
      { key: "incomplete", label: "未完成模式", color: "#4f4" },
      { key: "quiz", label: "自选题模式", color: "#fa0" },
    ];
    function updateModeLabel() {
      var m = MODE_LIST.find(function (x) { return x.key === currentMode; });
      if (modeLabel && m) { modeLabel.textContent = m.label; modeLabel.style.color = m.color; }
    }
    if (modeLabel) {
      modeLabel.addEventListener("click", function () {
        var cur = MODE_LIST.findIndex(function (x) { return x.key === currentMode; });
        currentMode = MODE_LIST[(cur + 1) % MODE_LIST.length].key;
        updateModeLabel();
        log("[模式] 切换为 " + modeLabel.textContent);
      });
    }
    updateModeLabel();

    btn.addEventListener("click", function () {
      if (mooc.state !== "IDLE" && mooc.state !== "PAUSED") { mooc.pause(); return; }
      mooc.sessionId++;
      var cfg = getConfig();
      var sid = mooc.sessionId;
      mooc.config = cfg;
      // 自选题模式：检测当前页面 DOM 直接处理
      // 未完成模式：从 API 拉取未完成任务列表
      // 自动检测：根据页面类型选择
      var usePageDetect = currentMode === "quiz" ||
        (currentMode === "auto" && isTestListPage());
      if (usePageDetect) {
        log("[模式] 自选题模式 — 检测当前页面");
        if (isTestListPage()) {
          handleTestList(cfg, sid, mooc);
        } else {
          // 其他页面：尝试处理当前页面的任务
          handleCurrentPage(cfg, sid, mooc);
        }
      } else {
        log("[模式] 未完成模式 — 任务列表");
        if (mooc.state === "PAUSED") { mooc.resume(); } else { mooc.start(); }
      }
    });
  }

  function updateUI() {
    const progress = document.getElementById("icourse-progress");
    const logBox = document.getElementById("icourse-log");
    const btn = document.getElementById("icourse-btn");
    if (!progress) return;
    const stateLabel = {
      IDLE: "就绪", FETCHING: "获取任务...", NAVIGATING: "跳转中...",
      WAITING_LOAD: "等待加载...", PROCESSING: "处理中...", PAUSED: "已暂停"
    };
    const total = mooc.tasks.length;
    const done = mooc.currentIndex;
    progress.textContent = total > 0
      ? (stateLabel[mooc.state] || mooc.state) + " (" + done + "/" + total + ")"
      : (stateLabel[mooc.state] || mooc.state);
    if (btn) { btn.textContent = (mooc.state === "PAUSED" || mooc.state === "IDLE") ? "▶" : "⏸"; }
    if (logBox) {
      logBox.innerHTML = logLines.slice(-10).map(function (l) { return "<div class=log-line>" + l + "</div>"; }).join("");
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function showHelpPanel() {
    var old = document.getElementById("icourse-popup-viewer");
    if (old) old.remove();
    var viewer = document.createElement("div");
    viewer.id = "icourse-popup-viewer";
    viewer.style.position = "fixed";
    viewer.innerHTML =
      "<div class=pv-head><span>使用说明</span><div class=pv-actions>" +
      "<button id=pv-close>关闭</button></div></div>" +
      "<div class=pv-body style='font-family:\"Segoe UI\",\"PingFang SC\",sans-serif;font-size:13px;line-height:1.8;color:#ddd;'>" +
      "<h3 style='color:#4fc;margin:0 0 10px;'>🎬 基本操作</h3>" +
      "<p>点击右下角 <b style='color:#e02020'>▶</b> 启动，<b style='color:#e02020'>⏸</b> 暂停。</p>" +

      "<h3 style='color:#4fc;margin:14px 0 10px;'>📋 三种模式</h3>" +
      "<table style='width:100%;border-collapse:collapse;font-size:12px;'>" +
      "<tr style='border-bottom:1px solid #444;'><td style='padding:4px;color:#4fc;'>自动检测</td><td style='padding:4px;'>根据当前页面自动选择模式</td></tr>" +
      "<tr style='border-bottom:1px solid #444;'><td style='padding:4px;color:#4f4;'>未完成模式</td><td style='padding:4px;'>从 API 拉取未完成任务列表，逐个执行（视频/文档/测试题/讨论题）</td></tr>" +
      "<tr style='border-bottom:1px solid #444;'><td style='padding:4px;color:#fa0;'>自选题模式</td><td style='padding:4px;'>检测当前页面 DOM，直接处理看到的任务</td></tr>" +
      "</table>" +
      "<p style='font-size:11px;color:#888;'>点击面板中「模式：xxx」可循环切换</p>" +

      "<h3 style='color:#4fc;margin:14px 0 10px;'>🖥️ 页面支持</h3>" +
      "<ul style='padding-left:18px;margin:4px 0;'>" +
      "<li><b>课件页</b> — 自动导航到未完成的视频/文档/测试题/讨论题</li>" +
      "<li><b>测验与作业页</b> — 自动检测「前往测验」，逐个完成单元测试</li>" +
      "<li><b>Quiz 页面</b> — 自动勾选同意 → 开始测验 → 答题 → 提交 → 确认</li>" +
      "</ul>" +

      "<h3 style='color:#4fc;margin:14px 0 10px;'>⚙️ 功能说明</h3>" +
      "<ul style='padding-left:18px;margin:4px 0;'>" +
      "<li><b>📚 任务列表</b> — 查看所有任务，可跳转到任意任务</li>" +
      "<li><b>⚙️ LLM 配置</b> — 设置 AI 答题的 API Key 和模型</li>" +
      "<li><b>视频倍速</b> — 调整视频播放速度（1x ~ 2x）</li>" +
      "<li><b>视频循环</b> — 视频结束后自动重播（刷时长）</li>" +
      "<li><b>跳过视频</b> — 跳过所有视频任务</li>" +
      "<li><b>仅做测试题</b> — 只处理测试题，跳过视频/文档</li>" +
      "</ul>" +

      "<h3 style='color:#4fc;margin:14px 0 10px;'>🛡️ 防重复机制</h3>" +
      "<ul style='padding-left:18px;margin:4px 0;'>" +
      "<li>测试列表页检测「有效测验成绩」表格判断是否已完成</li>" +
      "<li>Quiz 页面检测重做按钮判断是否已提交</li>" +
      "<li>答题完成后自动标记，避免重复做题</li>" +
      "</ul>" +

      "<h3 style='color:#4fc;margin:14px 0 10px;'>⚡ 并发限制</h3>" +
      "<p>遇到「并发限制」弹窗时脚本会自动关闭并等待重试。如频繁出现，可增大间隔时间。</p>" +

      "<h3 style='color:#4fc;margin:14px 0 10px;'>📝 日志</h3>" +
      "<p>面板底部显示最近 10 条操作日志，方便排查问题。</p>" +
      "</div>";
    document.body.appendChild(viewer);
    document.getElementById("pv-close").onclick = function () { viewer.remove(); };
  }

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
      "<div><div class=lbl>启用 LLM 答题</div><div class=sub>关闭后测试题与讨论题不会调用 LLM</div></div>" +
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

  // ─── 任务列表面板 ──────────────────────────────────────────────────────────

  const CONTENT_TYPE_LABELS = { 1: "视频", 3: "文档", 4: "富文本", 5: "测试题", 6: "讨论题" };

  function showTaskListPanel() {
    const old = document.getElementById("icourse-popup-viewer");
    if (old) old.remove();
    const viewer = document.createElement("div");
    viewer.id = "icourse-popup-viewer";
    const renderBody = function () {
      const curCfg = getConfig();
      const showAll = !!curCfg.includeDone;
      const tasks = mooc.tasks || [];
      const allUnits = mooc.allUnits || [];
      let bodyHtml = "";
      bodyHtml += "<div style='padding:8px 0;border-bottom:1px solid #333;margin-bottom:8px;'>";
      bodyHtml += "<label><input type=checkbox id=tl-include " + (showAll ? "checked" : "") + "> 列出已完成任务</label></div>";
      if (!showAll && !tasks.length) {
        if (!allUnits.length) {
          bodyHtml += "<div style='padding:14px;color:#888;'>暂无任务数据。<br><br><button id=tl-fetch style='padding:4px 10px;cursor:pointer;'>拉取任务列表</button></div>";
        } else {
          bodyHtml += "<div style='padding:14px;color:#888;'>当前队列为空。勾选上方复选框可查看全部任务点。</div>";
        }
        return bodyHtml;
      }
      if (showAll && !allUnits.length) {
        bodyHtml += "<div style='padding:14px;color:#888;'>暂无单元数据。<br><br><button id=tl-fetch style='padding:4px 10px;cursor:pointer;'>拉取任务列表</button></div>";
        return bodyHtml;
      }
      const list = showAll ? allUnits : tasks;
      const curIdx = mooc.currentIndex || 0;
      const groups = {};
      const groupOrder = [];
      list.forEach(function (u) {
        const key = (u._chapterName || "(未分组)") + " ▸ " + (u._lessonName || "");
        if (!groups[key]) { groups[key] = []; groupOrder.push(key); }
        groups[key].push({ unit: u });
      });
      groupOrder.forEach(function (g) {
        bodyHtml += "<details open><summary style='cursor:pointer;color:#4fc;padding:4px 0;'>" + escapeHtml(g) + "</summary>";
        bodyHtml += "<table style='width:100%;border-collapse:collapse;font-size:11px;'>";
        groups[g].forEach(function (rec) {
          const u = rec.unit;
          const done = (u.completePercent || 0) >= 1.0 || (u.learnTime && u.learnTime > 0);
          const typeLbl = CONTENT_TYPE_LABELS[u.contentType] || ("类型" + u.contentType);
          let stateLbl = done ? "<span style='color:#4f4;'>✓已完成</span>" : "<span style='color:#fa0;'>○未完成</span>";
          bodyHtml += "<tr style='border-bottom:1px solid #222;'>" +
            "<td style='padding:4px;width:70px;'>" + stateLbl + "</td>" +
            "<td style='padding:4px;width:50px;color:#aaa;'>" + escapeHtml(typeLbl) + "</td>" +
            "<td style='padding:4px;'>" + escapeHtml(u.name || "") + "</td>" +
            "<td style='padding:4px;width:80px;text-align:right;'>" +
            "<button class=tl-jump data-id='" + escapeHtml(String(u.id)) + "'>▶ 跳转</button></td></tr>";
        });
        bodyHtml += "</table></details>";
      });
      return bodyHtml;
    };
    const tasksCount = (mooc.tasks || []).length;
    const allCount = (mooc.allUnits || []).length;
    viewer.innerHTML =
      "<div class=pv-head><span>任务队列（" + tasksCount + " 待执行 / " + allCount + " 总计）</span>" +
      "<div class=pv-actions><button id=tl-refresh>刷新</button><button id=pv-close>关闭</button></div></div>" +
      "<div class=pv-body id=tl-body>" + renderBody() + "</div>";
    document.body.appendChild(viewer);
    const rerender = function () {
      document.getElementById("tl-body").innerHTML = renderBody();
      bind();
      const head = viewer.querySelector(".pv-head span");
      if (head) { head.textContent = "任务队列（" + (mooc.tasks || []).length + " 待执行 / " + (mooc.allUnits || []).length + " 总计）"; }
    };
    const bind = function () {
      const inc = document.getElementById("tl-include");
      if (inc) {
        inc.onchange = function () {
          const c = getConfig(); c.includeDone = inc.checked; saveConfig(c);
          mooc.config = c; rerender();
        };
      }
      const fetchBtn = document.getElementById("tl-fetch");
      if (fetchBtn) {
        fetchBtn.onclick = function () {
          fetchBtn.disabled = true; fetchBtn.textContent = "拉取中...";
          mooc.config = getConfig();
          mooc._refreshTaskList().then(function () { rerender(); }, function (err) {
            log("[任务列表] 拉取失败：" + err.message); fetchBtn.disabled = false; fetchBtn.textContent = "拉取任务列表";
          });
        };
      }
      viewer.querySelectorAll(".tl-jump").forEach(function (b) {
        b.onclick = function () {
          const id = b.getAttribute("data-id");
          const pool = (mooc.allUnits && mooc.allUnits.length) ? mooc.allUnits : (mooc.tasks || []);
          const u = pool.find(function (x) { return String(x.id) === id; });
          if (!u) return;
          viewer.remove(); mooc.jumpTo(u);
        };
      });
    };
    const refreshBtn = document.getElementById("tl-refresh");
    if (refreshBtn) {
      refreshBtn.onclick = function () {
        if (mooc.state !== "IDLE") return;
        mooc.config = getConfig();
        mooc._refreshTaskList().then(function () { rerender(); }, function (err) { log("拉取失败：" + err.message); });
      };
    }
    document.getElementById("pv-close").onclick = function () { viewer.remove(); };
    bind();
  }

  // ─── 主控制器 ────────────────────────────────────────────────────────────────

  // ─── 启动 ────────────────────────────────────────────────────────────────────

  buildUI();
  // 默认暂停状态，等待用户点击 ▶ 启动
  // 脚本会根据当前页面自动选择模式：
  //   内容页（#/learn/content）→ 未完成模式：加载未完成任务列表并执行
  //   测试列表页（#/learn/testlist）→ 自选题模式：检测页面上的测试题并逐个完成

})();
