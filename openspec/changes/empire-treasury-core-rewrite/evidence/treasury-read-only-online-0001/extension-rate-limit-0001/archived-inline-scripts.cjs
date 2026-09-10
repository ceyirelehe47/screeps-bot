// 【按执行内容整理归档】本轮 verify-1 / verify-2 / rc-reread 三次请求以 node -e 内联执行，
// 未能如其余脚本那样在执行前落盘；本文件按会话中实际执行的代码原样转录（与执行版本等价），
// 供独立复核请求次数与"纯 GET + 输出脱敏"性质。执行时间线见 extension-summary.md。
//
// —— verify-1（打开页面后 6 秒，行为探测）——
// const env = fs.readFileSync('D:/code/screeps/screeps-bot/.env','utf8');
// const t = env.match(/^SCREEPS_TOKEN=(.+)$/m)[1].trim();
// fetch('https://screeps.com/api/user/memory?shard=shard1&path=runtime',
//       { headers: { 'X-Token': t, 'X-Username': t } })
//   .then(async r => {
//     const text = (await r.text()).replace(/token=[0-9a-zA-Z]+/g, 'token=<REDACTED>');
//     console.log('status='+r.status+' remaining='+r.headers.get('x-ratelimit-remaining')
//                 +' retry-after='+r.headers.get('retry-after'));
//     console.log('bodyHead='+JSON.stringify(text.slice(0,200)));
//     fs.writeFileSync('a5-ratelimit/verify-1.json', text);   // 写盘前已脱敏
//   });
//
// —— verify-2（点击 Proceed 后 3 秒，通路恢复确认，HTTP 200）——
// 与 verify-1 完全相同的请求，写盘文件名为 verify-2.json；随后另行解码：
//   const j = JSON.parse(raw);
//   const payload = j.data.startsWith('gz:')
//     ? zlib.gunzipSync(Buffer.from(j.data.slice(3), 'base64')).toString('utf8') : j.data;
//   fs.writeFileSync('a5-ratelimit/memory-runtime.decoded.json', payload);  // 游戏数据，无凭据
//
// —— rc-reread（49 tick 后时间对照，runtime.resourceControl）——
// fetch('https://screeps.com/api/user/memory?shard=shard1&path=runtime.resourceControl',
//       { headers: { 'X-Token': t, 'X-Username': t } })
//   .then(async r => {
//     const raw = await r.text();
//     fs.writeFileSync('a5-ratelimit/rc-reread.json', raw.replace(/token=[0-9a-zA-Z]+/g, 'token=<REDACTED>'));
//     const payload = /* 同上 gz 解码 */ ...;
//     console.log('HTTP '+r.status+' updatedAt='+rc.updatedAt);
//     for (const room of ['E4N58','E1N57','W1N57']) { /* 打印 used/free/energy 数值 */ }
//   });
// （git bash 中 $ 正则锚点写作 \$，语义不变）
