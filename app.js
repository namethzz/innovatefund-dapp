import { config } from "./config.js";

const $ = (id) => document.getElementById(id);
const ethers = window.ethers;
const ethereum = window.ethereum?.providers?.find((provider) => provider.isMetaMask)
  ?? (window.ethereum?.isMetaMask ? window.ethereum : null);
const chainHex = "0x" + config.chainId.toString(16);
const abi = [
  "function campaignCount() view returns (uint256)",
  "function campaignInfo(uint256) view returns (tuple(address owner,string title,string description,uint256 goal,uint256 raised,uint256 paid,uint256 refunded,uint64 fundingDeadline,uint64 requestDeadline,uint64 requestWindow,uint64 votingWindow,uint32 nextMilestone,bool terminated))",
  "function campaignDetails(uint256) view returns (tuple(string title,string description,uint256 allocation,string evidence,uint64 voteDeadline,uint256 approvedWeight,bool paid)[])",
  "function status(uint256) view returns (uint8)",
  "function contributions(uint256,address) view returns (uint256)",
  "function voted(uint256,uint256,address) view returns (bool)",
  "function refunded(uint256,address) view returns (bool)",
  "function historyCount(uint256) view returns (uint256)",
  "function historyEntry(uint256,uint256) view returns (tuple(uint8 kind,address account,uint256 amount,uint64 timestamp,uint32 milestone))",
  "function createCampaign(string,string,uint64,uint64,uint64,tuple(string title,string description,uint256 allocation)[]) returns (uint256)",
  "function contribute(uint256) payable",
  "function requestRelease(uint256,string)",
  "function approveMilestone(uint256)",
  "function releaseFunds(uint256)",
  "function closeFailedMilestone(uint256)",
  "function refundContribution(uint256)",
  "event CampaignCreated(uint256 indexed id,address indexed owner)"
];

const states = ["เปิดรับทุน", "ถึงเป้าหมาย", "หมดเวลาระดมทุน", "ยุติโครงการ", "จ่ายครบแล้ว"];
const perPage = 6n;
const entriesPerPage = 10n;
let wallet;
let disconnected = false;
let pending = false;
let readPromise;
let campaignPage = 0n;
let historyPage = 0n;
let listRevision = 0;
let detailRevision = 0;
const initialId = new URLSearchParams(location.search).get("campaign");
let activeId = /^[1-9][0-9]{0,19}$/.test(initialId ?? "") ? BigInt(initialId) : null;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function button(label, action, className) {
  const node = element("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function notice(message, error = false, node = $("notice")) {
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle("error", error);
}

function message(error) {
  if (error.code === 4001 || error.code === "ACTION_REJECTED") return "ยกเลิกรายการใน MetaMask";
  if (error.code === "INSUFFICIENT_FUNDS") return "ยอด Sepolia ETH ไม่พอสำหรับยอดส่งและค่าธรรมเนียม";
  return error.reason || error.shortMessage || error.message || "ทำรายการไม่สำเร็จ";
}

function blockchainLibrary() {
  if (!ethers) throw new Error("โหลดไลบรารี Ethereum ไม่สำเร็จ กรุณารีเฟรช");
  return ethers;
}

function eth(value) {
  return ethers.formatEther(value) + " ETH";
}

function parseAmount(value) {
  blockchainLibrary();
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error("กรอกจำนวน ETH ทศนิยมได้ไม่เกิน 18 ตำแหน่ง");
  const amount = ethers.parseEther(value);
  if (amount <= 0n) throw new Error("จำนวน ETH ต้องมากกว่า 0");
  return amount;
}

function percent(value, total) {
  return total === 0n ? 0 : Number(value * 10000n / total) / 100;
}

function shorten(account) {
  return account.slice(0, 8) + "…" + account.slice(-4);
}

const date = (seconds) => new Date(Number(seconds) * 1000).toLocaleString("th-TH", {timeZone: "Asia/Bangkok"});

function clock(deadline) {
  const text = element("span");
  text.dataset.deadline = String(deadline);
  updateClock(text);
  return text;
}

function updateClock(node) {
  const seconds = Math.max(0, Number(node.dataset.deadline) - Math.floor(Date.now() / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  node.textContent = seconds ? [days && days + " วัน", hours && hours + " ชม.", minutes && minutes + " นาที", seconds < 60 && seconds + " วินาที"].filter(Boolean).join(" ") : "หมดเวลา";
}

function metric(name, value) {
  const box = element("div", undefined, "metric");
  box.append(element("span", name), element("strong", value));
  return box;
}

function explorerLink(address) {
  const link = element("a", shorten(address));
  link.href = config.explorer + "/address/" + address;
  link.title = address;
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

async function openReader() {
  blockchainLibrary();
  const address = ethers.getAddress(config.address);
  const providers = config.rpc.map((url) => {
    const request = new ethers.FetchRequest(url);
    request.timeout = 7000;
    return new ethers.JsonRpcProvider(request, config.chainId);
  });
  if (ethereum && await ethereum.request({method: "eth_chainId"}).catch(() => null) === chainHex) {
    providers.push(new ethers.BrowserProvider(ethereum, config.chainId));
  }
  return Promise.any(providers.map(async (provider) => {
    if (await provider.getCode(address) === "0x") throw new Error("Missing contract");
    return new ethers.Contract(address, abi, provider);
  })).catch(() => { throw new Error("อ่าน Smart Contract บน Sepolia ไม่สำเร็จ กรุณาลองใหม่"); });
}

function reader() {
  if (!config.address) throw new Error("รอเชื่อม Smart Contract บน Sepolia");
  readPromise ??= openReader().catch((error) => {
    readPromise = undefined;
    throw error;
  });
  return readPromise;
}

async function refreshList() {
  const revision = ++listRevision;
  $("list-status").textContent = "กำลังอ่านโครงการ…";
  $("campaign-pages").hidden = true;
  try {
    const contract = await reader();
    const count = await contract.campaignCount();
    const top = count - campaignPage * perPage;
    const items = await Promise.all(Array.from({length: Number(top > perPage ? perPage : top)}, async (_, index) => {
      const id = top - BigInt(index);
      const [info, status] = await Promise.all([contract.campaignInfo(id), contract.status(id)]);
      return campaignTile(id, info, status);
    }));
    if (revision !== listRevision) return;
    $("campaigns").replaceChildren(...items);
    $("list-status").textContent = count ? count + " โครงการบน Sepolia" : "ยังไม่มีโครงการระดมทุน";
    $("campaign-pages").hidden = count <= perPage;
    $("campaign-prev").disabled = campaignPage === 0n;
    $("campaign-next").disabled = top <= perPage;
  } catch (error) {
    if (revision === listRevision) $("list-status").textContent = message(error);
  }
}

function campaignTile(id, info, status) {
  const item = element("article", undefined, "tile");
  const progress = element("progress");
  progress.max = 100;
  progress.value = percent(info.raised, info.goal);
  progress.setAttribute("aria-label", "ความคืบหน้าโครงการ " + info.title);
  const remaining = element("p");
  if (status === 0n) remaining.append("เหลือ ", clock(info.fundingDeadline));
  else remaining.textContent = "ปิดรับทุน " + date(info.fundingDeadline);
  item.append(
    element("span", states[Number(status)], "tag"), element("h3", info.title), progress,
    element("p", eth(info.raised) + " / " + eth(info.goal)), remaining,
    button("ดูโครงการ #" + id, () => selectCampaign(id))
  );
  return item;
}

function selectCampaign(id) {
  activeId = id;
  historyPage = 0n;
  const url = new URL(location.href);
  url.searchParams.set("campaign", id);
  history.replaceState(null, "", url);
  void refreshDetail(true);
}

async function refreshDetail(scroll = false) {
  if (!activeId) return;
  const id = activeId;
  const account = wallet;
  const revision = ++detailRevision;
  const target = $("detail");
  target.hidden = false;
  try {
    const contract = await reader();
    const [info, milestones, status, count] = await Promise.all([
      contract.campaignInfo(id), contract.campaignDetails(id), contract.status(id), contract.historyCount(id)
    ]);
    const top = count - historyPage * entriesPerPage;
    const index = Number(info.nextMilestone);
    const [weight, claimed, voted, entries] = await Promise.all([
      account ? contract.contributions(id, account) : 0n,
      account ? contract.refunded(id, account) : false,
      account && index < milestones.length ? contract.voted(id, index, account) : false,
      Promise.all(Array.from({length: Number(top > entriesPerPage ? entriesPerPage : top)}, (_, offset) => contract.historyEntry(id, top - 1n - BigInt(offset))))
    ]);
    if (detailRevision !== revision) return;

    const metrics = element("div", undefined, "metrics");
    metrics.append(metric("ยอดระดมทุน", eth(info.raised)), metric("เป้าหมาย", eth(info.goal)),
      metric("จ่ายแล้ว", eth(info.paid)), metric("คืนแล้ว", eth(info.refunded)));
    const ownerLine = element("p", undefined, "detail-copy");
    ownerLine.append("เจ้าของโครงการ ", explorerLink(info.owner));
    const deadline = element("p", "กำหนดปิดรับทุน " + date(info.fundingDeadline), "detail-copy");
    if (status === 0n) deadline.append(" · เหลือ ", clock(info.fundingDeadline));
    const steps = element("div", undefined, "steps");
    for (const [position, milestone] of milestones.entries()) {
      steps.append(milestoneCard(info, milestone, position, status));
    }
    target.replaceChildren(element("span", states[Number(status)], "tag"), element("h2", info.title),
      element("p", info.description, "detail-copy"), ownerLine, deadline, metrics, element("h3", "Milestones"), steps,
      campaignActions(id, info, milestones[index], status, {account, weight, claimed, voted}),
      element("h3", "ประวัติเงินเข้า–ออก"), historyTable(entries));
    if (count > entriesPerPage) {
      const pagination = element("div", undefined, "pagination");
      const previous = button("ธุรกรรมใหม่กว่า", () => { historyPage -= 1n; void refreshDetail(); });
      const next = button("ธุรกรรมเก่ากว่า", () => { historyPage += 1n; void refreshDetail(); });
      previous.disabled = historyPage === 0n;
      next.disabled = top <= entriesPerPage;
      pagination.append(previous, next);
      target.append(pagination);
    }
    if (scroll) target.scrollIntoView({block: "start", behavior: "smooth"});
  } catch (error) {
    if (revision === detailRevision) target.textContent = message(error);
  }
}

function milestoneCard(info, milestone, index, status) {
  const card = element("article", undefined, "step");
  let state = "รอถึงลำดับ";
  const current = index === Number(info.nextMilestone);
  if (milestone.paid) state = "จ่ายแล้ว";
  else if (status === 2n || status === 3n) state = "ยกเลิก";
  else if (current && status === 1n) {
    if (milestone.approvedWeight > info.raised / 2n) state = "อนุมัติแล้ว · รอจ่าย";
    else if (milestone.voteDeadline) state = Number(milestone.voteDeadline) * 1000 > Date.now() ? "เปิดโหวต" : "หมดเวลาโหวต";
    else state = Number(info.requestDeadline) * 1000 > Date.now() ? "รอหลักฐาน" : "หมดเวลาส่งหลักฐาน";
  }
  card.append(element("span", state, "tag"), element("h3", (index + 1) + ". " + milestone.title),
    element("p", milestone.description), element("p", "งบจัดสรร " + eth(milestone.allocation)));
  if (milestone.evidence) {
    const evidence = element("p", "หลักฐาน ");
    const source = milestone.evidence;
    if (/^https?:\/\/\S+$/i.test(source)) {
      const link = element("a", source);
      link.href = source;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      evidence.append(link);
    } else {
      evidence.append(source);
    }
    card.append(evidence, element("p", "เสียงอนุมัติ " + percent(milestone.approvedWeight, info.raised) + "% · ปิดโหวต " + date(milestone.voteDeadline)));
  }
  if (current && status === 1n) {
    const deadline = milestone.voteDeadline || info.requestDeadline;
    const remaining = element("p", milestone.voteDeadline ? "เวลาโหวตที่เหลือ " : "เวลาส่งหลักฐานที่เหลือ ");
    remaining.append(clock(deadline));
    card.append(remaining);
  }
  return card;
}

function actionForm(label, name, hint, submitLabel, handler) {
  const form = element("form");
  const field = element("label", label);
  const input = element("input");
  input.name = name;
  input.placeholder = hint;
  input.required = true;
  input.maxLength = 400;
  field.append(input);
  const submit = element("button", submitLabel, "primary");
  form.append(field, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void handler(input.value.trim());
  });
  return form;
}

function campaignActions(id, info, milestone, status, user) {
  const controls = element("div", undefined, "action-list");
  const {account, weight, claimed, voted} = user;
  if (!account) {
    controls.append(button("เชื่อมต่อ MetaMask เพื่อทำรายการ", connect));
    return controls;
  }
  const owner = account.toLowerCase() === info.owner.toLowerCase();
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (status === 0n && !owner) {
    const remaining = info.goal - info.raised;
    controls.append(actionForm("สนับสนุน ETH", "amount", "สูงสุด " + ethers.formatEther(remaining), "สนับสนุน", (value) => submitTransaction((contract) => {
      const amount = parseAmount(value);
      if (amount > remaining) throw new Error("จำนวนเงินเกินยอดที่ยังเปิดรับ");
      return contract.contribute(id, {value: amount});
    })));
  }
  if (status === 1n && milestone) {
    const approved = milestone.approvedWeight > info.raised / 2n;
    if (!milestone.voteDeadline && owner && now < info.requestDeadline) {
      controls.append(actionForm("หลักฐานความสำเร็จ", "evidence", "ข้อความหรือ URL", "ส่งคำขอเบิก", (value) => submitTransaction((contract) => {
        if (!value) throw new Error("กรุณากรอกหลักฐาน");
        return contract.requestRelease(id, value);
      })));
    }
    if (!approved && milestone.voteDeadline > now && weight > 0n && !voted) {
      controls.append(button("โหวตอนุมัติ (" + percent(weight, info.raised) + "%)", () =>
        submitTransaction((contract) => contract.approveMilestone(id)), "primary"));
    }
    if (approved) {
      controls.append(button("จ่ายตาม Milestone", () => submitTransaction((contract) => contract.releaseFunds(id)), "primary"));
    } else if ((milestone.voteDeadline || info.requestDeadline) <= now) {
      controls.append(button("ปิด Milestone ที่หมดเวลา", () => submitTransaction((contract) => contract.closeFailedMilestone(id))));
    }
  }
  if ((status === 2n || status === 3n) && weight > 0n) {
    controls.append(claimed ? element("p", "บัญชีนี้รับเงินคืนแล้ว", "muted")
      : button("ขอรับเงินคืน", () => submitTransaction((contract) => contract.refundContribution(id)), "primary"));
  }
  if (!controls.childNodes.length) controls.append(element("p", "ยังไม่มีรายการที่บัญชีนี้ทำได้", "muted"));
  return controls;
}

function historyTable(entries) {
  if (!entries.length) return element("p", "ยังไม่มีรายการเงินเข้า–ออก", "detail-copy");
  const wrap = element("div", undefined, "table-wrap");
  const table = element("table");
  const header = table.createTHead().insertRow();
  for (const title of ["รายการ", "Wallet", "จำนวน", "เวลาไทย"]) {
    const cell = element("th", title);
    cell.scope = "col";
    header.append(cell);
  }
  const body = table.createTBody();
  for (const entry of entries) {
    const row = body.insertRow();
    const titles = ["รับทุน", "จ่ายระยะที่ " + (entry.milestone + 1n), "คืนเงิน"];
    row.insertCell().textContent = titles[Number(entry.kind)];
    row.insertCell().append(explorerLink(entry.account));
    row.insertCell().textContent = eth(entry.amount);
    row.insertCell().textContent = date(entry.timestamp);
  }
  wrap.append(table);
  return wrap;
}

function setWallet(account) {
  wallet = disconnected ? undefined : account;
  $("wallet").textContent = wallet ? shorten(wallet) + " · ตัดการเชื่อมต่อ" : "เชื่อมต่อ MetaMask";
  void refreshDetail();
}

async function connect() {
  try {
    if (!ethereum) throw new Error("เปิดหน้านี้ในเบราว์เซอร์ที่ติดตั้ง MetaMask");
    disconnected = false;
    const [account] = await ethereum.request({method: "eth_requestAccounts"});
    if (!account) throw new Error("ไม่พบ Wallet ที่เชื่อมต่อ");
    setWallet(account);
    notice("");
    return account;
  } catch (error) {
    notice(message(error), true);
  }
}

async function submitTransaction(run, statusNode = $("notice")) {
  if (pending) return null;
  pending = true;
  try {
    await reader();
    const account = wallet ?? await connect();
    if (!account) throw new Error("เชื่อมต่อ MetaMask เพื่อทำรายการ");
    if (await ethereum.request({method: "eth_chainId"}) !== chainHex) {
      await ethereum.request({method: "wallet_switchEthereumChain", params: [{chainId: chainHex}]});
    }
    if (wallet?.toLowerCase() !== account.toLowerCase()) throw new Error("บัญชี MetaMask เปลี่ยน กรุณาทำรายการใหม่");
    const provider = new ethers.BrowserProvider(ethereum, config.chainId);
    const signer = await provider.getSigner(account);
    const contract = new ethers.Contract(config.address, abi, signer);
    notice("ตรวจรายละเอียดและยืนยันใน MetaMask", false, statusNode);
    const tx = await run(contract);
    notice("รอการยืนยันบน Sepolia " + tx.hash, false, statusNode);
    const receipt = await tx.wait();
    notice("บันทึกรายการบน Sepolia แล้ว");
    if (statusNode !== $("notice")) notice("", false, statusNode);
    void refreshList();
    void refreshDetail();
    return {receipt, contract};
  } catch (error) {
    notice(message(error), true, statusNode);
    return null;
  } finally {
    pending = false;
  }
}

const allocations = $("allocations");
function updateGoal() {
  const fields = [...allocations.querySelectorAll('[name="allocation"]')];
  try {
    const total = fields.reduce((sum, field) => sum + (field.value ? parseAmount(field.value) : 0n), 0n);
    $("goal").textContent = ethers ? eth(total) : "0 ETH";
  } catch {
    $("goal").textContent = "กรอกจำนวน ETH ให้ถูกต้อง";
  }
  $("add-milestone").disabled = fields.length >= 10;
  for (const remove of allocations.querySelectorAll("button")) remove.disabled = fields.length === 1;
}

function addMilestone() {
  if (allocations.children.length >= 10) return;
  const row = element("div", undefined, "milestone-row");
  const title = element("label", "ชื่อระยะงาน");
  const name = element("input");
  name.name = "milestone";
  name.maxLength = 80;
  name.required = true;
  title.append(name);
  const cost = element("label", "จัดสรร (ETH)");
  const amount = element("input");
  amount.name = "allocation";
  amount.inputMode = "decimal";
  amount.required = true;
  cost.append(amount);
  const remove = button("ลบ", () => { row.remove(); updateGoal(); });
  const details = element("label", "รายละเอียดระยะงาน", "milestone-details");
  const description = element("input");
  description.name = "milestone-description";
  description.maxLength = 400;
  description.required = true;
  details.append(description);
  row.append(title, cost, remove, details);
  allocations.append(row);
  updateGoal();
}

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const result = await submitTransaction((contract) => {
    const titles = fields.getAll("milestone").map((value) => value.trim());
    const descriptions = fields.getAll("milestone-description").map((value) => value.trim());
    const amounts = fields.getAll("allocation").map((value) => parseAmount(value.trim()));
    const plan = titles.map((title, index) => [title, descriptions[index], amounts[index]]);
    const title = fields.get("title").trim();
    const description = fields.get("description").trim();
    if (!title || !description || plan.some(([name, details]) => !name || !details)) throw new Error("กรอกชื่อและรายละเอียดให้ครบ");
    const duration = ["funding", "request", "voting"].map((name) => Number(fields.get(name)) * 60);
    return contract.createCampaign(title, description, ...duration, plan);
  }, $("form-status"));
  if (!result) return;
  form.reset();
  allocations.replaceChildren();
  addMilestone();
  $("create-dialog").close();
  campaignPage = 0n;
  void refreshList();
  for (const log of result.receipt.logs) {
    if (log.address.toLowerCase() !== config.address.toLowerCase()) continue;
    const event = result.contract.interface.parseLog(log);
    if (event?.name === "CampaignCreated") selectCampaign(event.args.id);
  }
});

$("wallet").addEventListener("click", () => {
  if (wallet) {
    disconnected = true;
    setWallet();
  } else {
    void connect();
  }
});
$("refresh").addEventListener("click", () => {
  readPromise = undefined;
  void refreshList();
  void refreshDetail();
});
$("open-create").addEventListener("click", () => $("create-dialog").showModal());
$("close-create").addEventListener("click", () => $("create-dialog").close());
$("add-milestone").addEventListener("click", addMilestone);
allocations.addEventListener("input", updateGoal);
$("campaign-prev").addEventListener("click", () => { campaignPage -= 1n; void refreshList(); });
$("campaign-next").addEventListener("click", () => { campaignPage += 1n; void refreshList(); });
ethereum?.on("accountsChanged", (accounts) => setWallet(accounts[0]));
ethereum?.on("chainChanged", () => {
  readPromise = undefined;
  void refreshList();
  void refreshDetail();
});
setInterval(() => {
  const expired = [...document.querySelectorAll("[data-deadline]")].reduce((changed, node) => {
    const before = node.textContent;
    updateClock(node);
    return changed || (before !== node.textContent && node.textContent === "หมดเวลา");
  }, false);
  if (expired) { void refreshList(); void refreshDetail(); }
}, 1000);

if (config.address) {
  $("explorer").href = config.explorer + "/address/" + config.address;
  $("explorer").hidden = false;
}
addMilestone();
void refreshList();
void refreshDetail();
