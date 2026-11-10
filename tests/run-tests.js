const fs=require('fs'), cp=require('child_process');
const tests=['test_merged.js','test_merged_ui.js','test_video_completion.js','test_playback_lifecycle.js','test_unit_identity.js','test_platform_autonext.js'];
let failed=false;
for(const file of tests){
 const result=cp.spawnSync(process.execPath,[],{input:fs.readFileSync('tests/'+file,'utf8'),encoding:'utf8',cwd:process.cwd()});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
 if(result.error){console.error(result.error.message);failed=true;}
 if(result.status!==0)failed=true;
}
if(!fs.readFileSync('mooc-assistant.user.js').equals(fs.readFileSync('mooc-assistant.txt'))){console.error('TXT 与脚本内容不一致');failed=true;}
process.exitCode=failed?1:0;
