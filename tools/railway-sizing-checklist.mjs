#!/usr/bin/env node

const services = [
  { letter:'A', name:'kalshi-420-bot', serviceId:'2eabd7c4-bac8-4582-9312-3ec8ae7bebdc', branch:'service-split-a-b-c', note:'A uses a ladder; verify every ladder step before redeploy.' },
  { letter:'B', name:'eth-jump-service', serviceId:'e3181583-08de-4a72-9e8b-4d3384a71cb4', branch:'candidate-portfolio-distribution-b', note:'Fixed-size jump service.' },
  { letter:'C', name:'eth-reversal-service', serviceId:'3d6c9cb7-bae0-4ea6-a1e7-07c65853e3a3', branch:'candidate-portfolio-distribution-c', note:'Fixed-size reversal service.' },
  { letter:'D', name:'eth-breakout-reversal', serviceId:'d8fbc79d-e0c1-4e48-9148-de669824c08e', branch:'candidate-portfolio-distribution-d', note:'Fixed-size breakout/reversal service.' },
  { letter:'E', name:'eth-downfade-e', serviceId:'31c57bcb-47c4-478e-87db-8ee1a1904007', branch:'candidate-portfolio-distribution-ef', note:'E and F share a source branch; change only the E-specific stake.' },
  { letter:'F', name:'eth-downfade-f', serviceId:'cb438462-c64e-4f70-8723-a1d5dfc62ad1', branch:'candidate-portfolio-distribution-ef', note:'E and F share a source branch; change only the F-specific stake.' },
  { letter:'G', name:'eth-downfade-g', serviceId:'a5f12123-b6cd-4230-af5f-5f3cd0aaf048', branch:null, note:'KEEP OFF. Do not enable.' },
  { letter:'H', name:'Ashley', serviceId:'2951fc35-3bc9-44c3-8816-86062c81f685', branch:'fix-h-adjacent-strike', note:'Ashley / H.' },
  { letter:'I', name:'Ash V2', serviceId:'0ef0e37c-0560-4b12-9247-831ed2c2774b', branch:'fix-i-adjacent-strike', note:'Ash V2 / I.' },
  { letter:'J', name:'Jackpot', serviceId:'94be4023-396d-4a6b-9614-2793108766f3', branch:'service-j-jackpot', note:'Jackpot / J.' },
];

const arg = (process.argv[2] || '').trim().toUpperCase();
const selected = arg ? services.filter(s => s.letter === arg) : services;
if (!selected.length) {
  console.error('Usage: node tools/railway-sizing-checklist.mjs [A|B|C|D|E|F|G|H|I|J]');
  process.exit(1);
}

console.log('NON-PRODUCTION CHECKLIST ONLY — this helper does not change Railway, GitHub branches, stakes, or deployments.');
console.log('Project: pacific-grace');
console.log('Environment: production');
console.log('Repo: mmaynard3344-cell/kalshi-420-bot');
console.log('');

for (const s of selected) {
  console.log(`${s.letter} — ${s.name}`);
  console.log(`  Railway service ID: ${s.serviceId}`);
  console.log(`  Current source branch: ${s.branch || 'N/A'}`);
  console.log(`  Note: ${s.note}`);
  if (s.letter === 'G') {
    console.log('  Action: leave disabled; skip sizing changes.');
  } else {
    console.log('  Manual workflow:');
    console.log('    1) Open the service in Railway > Settings / Source and confirm the branch above.');
    console.log('    2) Make the intended sizing-only edit in that service branch in GitHub.');
    console.log('    3) Review the diff: only wager/ladder sizing should change.');
    console.log('    4) Let Railway redeploy that one service.');
    console.log('    5) Wait for SUCCESS and inspect startup/runtime logs for the expected service role and stake.');
    console.log('    6) Only then proceed to the next service.');
  }
  console.log('');
}

console.log('Safety checks before each next service:');
console.log('  - no strategy thresholds changed');
console.log('  - no API/database credentials changed');
console.log('  - no service enable flags changed');
console.log('  - G remains off');
console.log('  - previous service deployment is SUCCESS');
