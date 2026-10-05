const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'badge-suite-'));
const env={...process.env};
try {
  // Install tests use a disposable fixture, never the developer's real desktop client.
  if(process.platform==='darwin'){
    const app=path.join(temp,'Fixture Client.app');
    const resources=path.join(app,'Contents/Resources');fs.mkdirSync(resources,{recursive:true});
    fs.writeFileSync(path.join(resources,'codex'),'#!/bin/sh\necho codex-cli fixture\n',{mode:0o755});
    fs.writeFileSync(path.join(resources,'AppIcon.icns'),'fixture icon');
    fs.writeFileSync(path.join(app,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Codex</string><key>CFBundleIconFile</key><string>AppIcon.icns</string></dict></plist>');
    env.CODEX_BADGE_APP=app;
  }
  const tests=['data-client','agent-scheduling','windows','windows-update','project-colors','project-sizes','thread-tokens','thread-token-layout','thread-metrics-reader','thread-metrics-store','thread-performance-tracker','thread-metrics-account-scope','thread-performance-ui','thread-metrics-layout','thread-metrics-refresh','windows-bridge','startup-controller','windows-startup-controller','windows-startup','mac-shortcuts','updater','regression'];
  if(process.platform==='darwin')tests.push('resolve','activation','lifecycle');
  for(const name of tests){
    console.log(`\nTesting ${name}`);
    const flags=name==='regression'&&process.platform!=='darwin'?['--ui-only']:[];
    const result=spawnSync(process.execPath,[path.join(__dirname,name+'.cjs'),...flags],{stdio:'inherit',env});
    if(result.status!==0)throw new Error(`${name} failed (${result.status})`);
  }
} finally {fs.rmSync(temp,{recursive:true,force:true});}
