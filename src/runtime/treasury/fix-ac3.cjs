const fs = require("fs");
const f = "D:/code/screeps/screeps-bot/src/runtime/treasury/actionContracts.ts";
let t = fs.readFileSync(f, "utf8");
const applied = [];
function seg(name, oldStr, newStr) {
  if (t.split(oldStr).length - 1 !== 1) throw new Error("seg " + name + " count=" + (t.split(oldStr).length - 1));
  t = t.split(oldStr).join(newStr);
  applied.push(name);
}

// 1) AC3 digest：绑定 durable facts（version + payload hash）与 reconciliation contract version
seg(
  "ac3",
  `  const sortedPostings = [...derived].sort((a, b) => (postingKey(a) < postingKey(b) ? -1 : postingKey(a) > postingKey(b) ? 1 : 0));
  const digest = hashTreasuryCanonicalString(
    \`AC2:ce:\${String(TREASURY_CANONICAL_ENCODING_VERSION)}:k:\${String(request.actionKind.length)}:\${request.actionKind}:av:\${String(adapter.version)}:t:\${String(request.transactionId.length)}:\${request.transactionId}:a:\${String(canonicalized.text.length)}:\${canonicalized.text}:p:\${sortedPostings.map(canonicalPostingText).join(",")}:s:\${canonicalStructuresText(structureSnapshots)}\`,
  );`,
  `  const sortedPostings = [...derived].sort((a, b) => (postingKey(a) < postingKey(b) ? -1 : postingKey(a) > postingKey(b) ? 1 : 0));
  // 【第十轮 3.12.6/AC3】durable reconciliation facts 绑定进 contract identity：
  // durable payload version 与内容的稳定 hash、reconciliation contract version
  //（adapter 提供 reconciler 时 durable facts 必填）。durable facts 变化 →
  // digest 变化 → 旧 bundle/授权全部失效（不得复用）。
  if (adapter.reconcile !== undefined && durableFacts === undefined) {
    actionContractEvents.rejected += 1;
    return {
      status: "rejected",
      reason: "contract_invalid",
      detail: "adapter 提供 reconciler 但未提供 durableFacts（production contract 的 durable reconciliation facts 必填）",
    };
  }
  const durableText =
    durableFacts !== undefined
      ? `:dfv:${String(durableFacts.version)}:dfh:${String(hashTreasuryCanonicalString(durableFacts.payload).length)}:${hashTreasuryCanonicalString(durableFacts.payload)}:rcv:${String(durableFacts.version)}`
      : ":df:none";
  const digest = hashTreasuryCanonicalString(
    \`AC3:ce:\${String(TREASURY_CANONICAL_ENCODING_VERSION)}:k:\${String(request.actionKind.length)}:\${request.actionKind}:av:\${String(adapter.version)}:t:\${String(request.transactionId.length)}:\${request.transactionId}:a:\${String(canonicalized.text.length)}:\${canonicalized.text}:p:\${sortedPostings.map(canonicalPostingText).join(",")}:s:\${canonicalStructuresText(structureSnapshots)}\${durableText}\`,
  );`,
);

fs.writeFileSync(f, t, "utf8");
console.log("applied:", applied.join(", "));
