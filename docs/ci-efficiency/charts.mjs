// Run at the repository root with the existing lockfile installation.
import { readFileSync, writeFileSync } from 'node:fs';
import { csvParse, scaleLinear, sum } from 'd3';

const dir = new URL('./', import.meta.url);
const read = name => csvParse(readFileSync(new URL('data/' + name, dir), 'utf8'));
const runs = read('history-runs.csv').filter(r => r.workflow === 'Validate' && ['push', 'pull_request'].includes(r.event));
const sampled = read('history-validate-replay.csv');
const weeks = ['Oct 25–31', 'Nov 1–7', 'Nov 8–14', 'Nov 15–21', 'Nov 22–23*'];
const week = r => Math.floor((Date.parse(r.day) - Date.parse('2026-10-25')) / 604800000);
const colors = {pull_request:'#00767a',push:'#a64424'};
const pts = [];
for (let w = 0; w < weeks.length; w++) {
  for (const event of Object.keys(colors)) {
    const n = runs.filter(r => week(r) === w && r.event === event).length;
    const mins = sum(sampled.filter(r => week(r) === w && r.event === event), r => r.weight * r.macos_execution_s / 60);
    pts.push({w,event,n,avg:mins / n});
  }
}
const x = scaleLinear().domain([0,4]).range([110,650]);
const y = scaleLinear().domain([0, Math.max(...pts.map(p=>p.avg))]).nice(4).range([220,64]);
const lines = [];
const text = (x,y,s,attr='') => lines.push('<text x="'+x+'" y="'+y+'" '+attr+'>'+s+'</text>');
lines.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 326" role="img" aria-labelledby="title desc"><title id="title">Estimated macOS execution minutes per ordinary Validate run</title><desc id="desc">Run-created weekly estimates for pull requests and main pushes. Includes cancellations. The final bucket covers two dates. Sparse stratified sample, especially for long jobs.</desc><rect width="760" height="326" fill="#fff"/><g font-family="system-ui,sans-serif" fill="#18313e" font-size="12">');
text(20,27,'Estimated macOS runner-minutes per Validate run','font-size="19" font-weight="bold"');
text(20,47,'PR and main-push cohorts, including cancelled and skipped runs in the denominator');
for (const tick of y.ticks(5)) {
  lines.push('<path d="M68 '+y(tick)+'H710" stroke="#d4dee1"/>');
  text(60,y(tick)+4,tick,'text-anchor="end"');
}
for (const event of Object.keys(colors)) {
  const items = pts.filter(p=>p.event===event), off = event === 'push' ? 7 : -7;
  const path = items.map((p,i)=>(i?'L':'M')+(x(p.w)+off)+' '+y(p.avg)).join(' ');
  lines.push('<path d="'+path+'" fill="none" stroke="'+colors[event]+'" stroke-width="2.5"/>');
  for (const p of items) lines.push('<circle cx="'+(x(p.w)+off)+'" cy="'+y(p.avg)+'" r="4" fill="'+colors[event]+'"><title>'+event+' '+weeks[p.w]+': '+p.avg.toFixed(2)+' min/run; '+p.n+' runs</title></circle>');
}
weeks.forEach((s,i)=>text(x(i),244,s,'text-anchor="middle"'));
text(22,273,'● Pull request','fill="'+colors.pull_request+'"');text(135,273,'● Main push','fill="'+colors.push+'"');
text(22,298,'Validate pause merged Nov 16, inside the fourth bucket. *Partial week through Nov 23 23:29 UTC.');
text(22,317,'Stratified estimates; changes in workload, cancellations and workflow versions also affect this series.');
lines.push('</g></svg>');
writeFileSync(new URL('ordinary-macos.svg',dir),lines.join('\n')+'\n');
console.table(pts.map(({w,event,n,avg})=>({period:weeks[w],event,runs:n,mac_minutes_per_run:avg.toFixed(2)})));
