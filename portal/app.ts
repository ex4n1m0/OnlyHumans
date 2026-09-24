// Browser runtime for the OnlyHumans portal (join.html): a mailbox-only
// room member. See portal.ts for the protocol mirror + KAT provenance.

import {
  Hub, RoomCrypto, buildJoin, effectiveGk, globalRoomHex, dmRoomHex,
  openRoomKey, sealRoomKey, peerIdFromPublic, publicKeyProtobuf,
  ed25519RawFromProtobuf, verifyMailItem, admissionProof,
  b64, unb64, unhex, hex, utf8, fromUtf8, concat, type Envelope, type MemberInfo, type Sealed,
} from "./portal.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const KIND = {
  chat: utf8("chat\0\0\0\0"),
  rotate: utf8("rotate\0\0"),
  members: utf8("members\0"),
  dminvite: utf8("dminvite"),
  profile: utf8("profile\0"),
  ping: utf8("ping\0\0\0\0"),
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/// Build id = the content hash in this bundle's own script URL. The
/// shipped file is the single source of truth, so the UI can never show
/// a stale version after `npm run build:portal` mints a new bundle.
const BUILD = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src ?? "";
  return /portal-([A-Za-z0-9]+)\.js/.exec(src)?.[1] ?? "dev";
})();

/// Local-only browser label parsed from the UA — nothing is sent or
/// stored anywhere (the site stays identity-free). Answers "which
/// browser is this?" during support without server-side tracking.
const BROWSER = (() => {
  const ua = navigator.userAgent;
  const m = (re: RegExp) => re.exec(ua)?.[1];
  const ios = /iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const os = ios ? `iOS ${m(/OS (\d+[._]\d+)/)?.replace("_", ".") ?? "?"}`
    : m(/Android (\d+)/) ? `Android ${m(/Android (\d+)/)}`
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh/.test(ua) ? "macOS" : "unknown OS";
  const name = m(/Edg\/(\d+)/) ? `Edge ${m(/Edg\/(\d+)/)}`
    : m(/CriOS\/(\d+)/) ? `Chrome ${m(/CriOS\/(\d+)/)}`
    : m(/FxiOS\/(\d+)/) ? `Firefox ${m(/FxiOS\/(\d+)/)}`
    : m(/Chrome\/(\d+)/) ? `Chrome ${m(/Chrome\/(\d+)/)}`
    : m(/Firefox\/(\d+)/) ? `Firefox ${m(/Firefox\/(\d+)/)}`
    : m(/Version\/(\d+).*Safari/) ? `Safari ${m(/Version\/(\d+)/)}` : "unknown browser";
  return `${name} · ${os}`;
})();

// ------------------------------------------------------------- language
// docs/chinese-simplified-study.md: one shared key with the landing
// (oh-lang — the landing's dropdown writes it, the portal follows, the
// identity menu / gate footer can flip it). Strings captured at event
// time (log lines, narration, statuses) translate when they happen;
// history keeps the language it was made in. Brand names and typed
// literals (earth, build hashes) are never translated.
type Lang = "en" | "zh";
const STR: Record<Lang, Record<string, string>> = {
  en: {
    "doc.title": "Join a room — OnlyHumans",
    "gate.top": "Private Chat Rooms",
    "gate.slogan": "Every Word is a Key",
    "gate.namePh": "your name…",
    "gate.wordPh": "room word",
    "gate.enter": "Enter the room",
    "gate.rememberTitle": "saves your name and your recently used room words in this browser — nothing else, and unchecking removes it",
    "gate.remember": "remember my name and rooms on this device",
    "gate.build": "browser portal · build {b}",
    "gate.errName": "A name is required.",
    "invite.text": "Join me in a room on OnlyHumans — open this link, type any name, press Enter: {u}",
    "st.starting": "starting…",
    "st.finding": "finding the room…",
    "st.fetchBase": "fetching the room base…",
    "st.derive": "deriving the room from your word…",
    "st.register": "registering with the site…",
    "st.rejoin": "rejoining the room…",
    "st.askSeat": "asking host {h}… for a seat (attempt {n}) — their tab must be open",
    "log.contact": "contacting the site…",
    "log.siteOk": "the site answered",
    "log.siteDown": "the site is not answering — retrying",
    "log.firstFail": "first contact with the site failed — the connection loop takes over",
    "log.joinRetry": "could not finish joining — retrying in the background",
    "log.founded": "this tab created the room and is holding it open",
    "log.seatAsk": "seat request #{n} mailed to host {h}…",
    "log.seatRefused": "the site refused the seat request — retrying",
    "log.noHost": "no host on the site — claiming the room",
    "log.yieldHost": "another tab holds the room now — switching to a seat",
    "log.warped": "warped to universe {e} — the word's record will lapse",
    "log.successor": "seated {n} into the word's fresh universe — we stay in {e}",
    "log.takeover": "the host left — this tab took over the room",
    "log.seatedBy": "seated by host {h}… — universe {e}",
    "log.seatedJoin": "seated {n} — key sent",
    "log.dmOpened": "private chat with {n} opened",
    "log.reseatList": "the host's list no longer has us — re-seating",
    "log.reseatLeft": "the host left — finding the room again",
    "log.reseatSilent": "the host dropped our seat for silence — rejoining",
    "nar.otherHost": "· another live host holds the room",
    "nar.warped": "· warped to universe {e} — the word now starts a fresh room",
    "nar.drifted": "· {n} drifted off",
    "nar.hostLeft": "· the host left — this tab keeps the room open",
    "nar.left": "· {n} left",
    "nar.joined": "· {n} joined",
    "toast.imgFallback": "couldn't re-encode this picture here — it's queued as a file, sent as-is with its metadata",
    "toast.imgUnreadable": "couldn't read this image — some formats (like HEIC) aren't supported here, and pictures must shrink to size on your device",
    "toast.fileUnreadable": "couldn't read this file",
    "toast.fileEmpty": "this file is empty",
    "toast.fileBig": "this file is {n} KB — shared files must stay at or under 30 KB",
    "toast.mailCap": "this attachment didn't fit the mail limit — nothing was sent",
    "toast.invite": "Invite link copied — the room word is already inside it",
    "cmd.switchRoom": "switch between the room and your private chats",
    "cmd.editProfileTitle": "edit my profile — photo, name, bio, this room's picture",
    "cmd.editProfile": "Edit my profile",
    "cmd.yourProfile": "your profile",
    "side.people": "people in the room",
    "side.you": "this is you",
    "side.youTag": " (you)",
    "side.you2": "you",
    "side.viaSite": "via site",
    "side.dmTitle": "private chat with {n}",
    "side.dm": "⇄ message",
    "side.dms": "private chats",
    "side.unread": "{n} unread",
    "side.invited": "invited",
    "side.justTwo": "just you two",
    "tb.private": "private",
    "tb.dmSub": "vanishes when you both leave · sealed with a key only you two hold",
    "tb.back": "back to the room (Esc)",
    "tb.backBtn": "‹ room",
    "tb.peopleTitle": "people in this room",
    "tb.inRoom": "{n} in room",
    "tb.warpTitle": "move everyone here into a new universe — the word will start a fresh room for whoever types it next",
    "tb.warp": "✦ Warp",
    "tb.inviteTitle": "copy a link that opens this room — the word is already in it",
    "tb.invite": "＋ Invite",
    "hint.earthAlone": `You're in Earth — everyone who uses this word joins this room. Say hi, or <button id="p-invite-empty" class="linklike">invite a friend</button>.`,
    "hint.earthOthers": "You're in Earth — everyone who uses this word joins this room. Say hi.",
    "hint.wordAlone": `Nobody else has used this word yet — they land here the moment they type the same one. <button id="p-invite-empty" class="linklike">Invite someone</button>`,
    "hint.wordOthers": "You're in — only people who typed this room's word can be here.",
    "hint.dm": "This is a sealed two-person room — only you and {n} hold this key.",
    "hint.keepOpen": "Keep this tab open — the other side lands here the moment it uses the same word. Phones pause a tab when the screen locks; picking the phone back up reconnects it instantly.",
    "iq.readingFile": "reading the file…",
    "iq.shrinking": "shrinking the image to 30 KB…",
    "iq.ready": "ready — Enter sends",
    "iq.sentAsIs": "sent as-is",
    "iq.metaKept": "metadata kept",
    "iq.enterSends": "Enter sends",
    "iq.removeImg": "remove the image",
    "iq.removeFile": "remove the file",
    "cp.emojiTitle": "insert an emoji",
    "cp.attachTitle": "attach a picture or a file — pictures are re-encoded on your device to 30 KB or less (EXIF stripped); files up to 30 KB travel as-is",
    "cp.attachAria": "attach a picture or file",
    "cp.caption": "caption (optional)…",
    "cp.dmPh": "message privately… (Enter sends)",
    "cp.roomPh": "message the room… (Enter sends)",
    "cp.sendTitle": "Enter sends · Shift+Enter adds a newline",
    "cp.send": "Send",
    "msg.viaTitle": "travelled end-to-end sealed through the site's mailbox",
    "msg.imgAlt": "shared image",
    "msg.fileTitle": "download — sealed end-to-end, decoded on your device",
    "msg.webFile": "web page file — careful",
    "msg.download": "download",
    "msg.you": "you",
    "msg.reactTitle": "react to this message",
    "msg.reactAria": "add a reaction",
    "pf.sheetAria": "edit my profile",
    "pf.title": "Your profile",
    "pf.photo": "Photo…",
    "pf.remove": "remove",
    "pf.name": "name",
    "pf.bio": "bio",
    "pf.bioPh": "a line about you — shown to people in the room",
    "pf.roomTitle": "This room's picture",
    "pf.picture": "Picture…",
    "pf.cancel": "Cancel",
    "pf.save": "Save",
    "pf.note": "Everything here is session-only — it travels sealed to people in the room and vanishes when the tab closes. Nothing is stored anywhere.",
    "menu.buildHeader": "{n} · portal build {b}",
    "menu.logoff": "Log off",
    "menu.logoffHint": "back to the join screen — your key stays in this browser",
    "menu.browserLine": "{b} · Enter sends, Shift+Enter newline",
    "menu.lang": "Language / 语言",
    "menu.langHintEn": "switch to 简体中文",
    "menu.langHintZh": "切换到 English",
    "menu.warpQ": "warp to universe {n}?",
    "menu.warpGo": "✦ Warp",
    "menu.warpHint": "everyone here moves to a new key; the word founds a fresh room for newcomers",
    "menu.stay": "stay here",
    "menu.stayHint": "universe {n} keeps going",
    "menu.switch": "switch conversation",
    "menu.peopleRoom": "people in the room · {w}",
    "menu.thisDeviceHost": "this device — holding the room open",
    "menu.thisDevice": "this device",
    "menu.holdingOpen": "holding the room open",
    "menu.startDm": "start a private chat",
    "menu.dms": "private chats",
    "menu.roomEpoch": "{w} · universe {e}",
    "emj.faces": "faces", "emj.hands": "hands", "emj.hearts": "hearts",
    "emj.nature": "nature", "emj.animals": "animals", "emj.food": "food",
    "emj.play": "play", "emj.travel": "travel", "emj.things": "things",
    "emj.signs": "signs", "emj.recent": "recent", "emj.react": "react",
    "emj.more": "more emoji",
  },
  zh: {
    "doc.title": "加入房间 — OnlyHumans",
    "gate.top": "私密聊天室",
    "gate.slogan": "每个词都是一把钥匙",
    "gate.namePh": "你的名字…",
    "gate.wordPh": "房间词",
    "gate.enter": "进入房间",
    "gate.rememberTitle": "在此浏览器中保存你的名字和最近使用的房间词——仅此而已；取消勾选即删除",
    "gate.remember": "在此设备上记住我的名字和房间",
    "gate.build": "网页版 · 构建 {b}",
    "gate.errName": "请输入名字。",
    "invite.text": "来 OnlyHumans 的房间找我——打开这个链接，随便取个名字，按 Enter 进入：{u}",
    "st.starting": "正在启动…",
    "st.finding": "正在寻找房间…",
    "st.fetchBase": "正在获取房间基础…",
    "st.derive": "正在从你的词推导房间…",
    "st.register": "正在向站点注册…",
    "st.rejoin": "正在重新加入房间…",
    "st.askSeat": "正在向房主 {h}… 请求席位（第 {n} 次尝试）——对方的标签页必须保持打开",
    "log.contact": "正在联系站点…",
    "log.siteOk": "站点已响应",
    "log.siteDown": "站点无响应——正在重试",
    "log.firstFail": "与站点的首次联系失败——连接循环将接管",
    "log.joinRetry": "未能完成加入——正在后台重试",
    "log.founded": "此标签页创建了房间并将其保持开放",
    "log.seatAsk": "席位请求 #{n} 已邮寄给房主 {h}…",
    "log.seatRefused": "站点拒绝了席位请求——正在重试",
    "log.noHost": "站点上没有房主——正在认领房间",
    "log.yieldHost": "另一个标签页现在持有房间——切换为席位",
    "log.warped": "已跃迁到宇宙 {e}——该词的记录将失效",
    "log.successor": "已将 {n} 安置进该词的新宇宙——我们留在 {e}",
    "log.takeover": "房主离开了——此标签页接管了房间",
    "log.seatedBy": "已被房主 {h}… 安置——宇宙 {e}",
    "log.seatedJoin": "已安置 {n}——密钥已发送",
    "log.dmOpened": "与 {n} 的私聊已打开",
    "log.reseatList": "房主的名单里已没有我们——正在重新入座",
    "log.reseatLeft": "房主离开了——正在重新寻找房间",
    "log.reseatSilent": "房主因沉默撤回了我们的席位——正在重新加入",
    "nar.otherHost": "· 另一个在线房主持有该房间",
    "nar.warped": "· 已跃迁到宇宙 {e}——该词现在会开启一间新房间",
    "nar.drifted": "· {n} 悄然离线",
    "nar.hostLeft": "· 房主离开了——此标签页维持房间开放",
    "nar.left": "· {n} 离开了",
    "nar.joined": "· {n} 加入了",
    "toast.imgFallback": "无法在此重新编码这张图片——已按原文件排队，将连同其元数据原样发送",
    "toast.imgUnreadable": "无法读取这张图片——某些格式（如 HEIC）在此不受支持，且图片必须在你的设备上完成压缩",
    "toast.fileUnreadable": "无法读取此文件",
    "toast.fileEmpty": "此文件是空的",
    "toast.fileBig": "此文件有 {n} KB——共享文件不得超过 30 KB",
    "toast.mailCap": "此附件超出了邮件上限——未发送任何内容",
    "toast.invite": "邀请链接已复制——房间词已包含在内",
    "cmd.switchRoom": "在房间与你的私聊之间切换",
    "cmd.editProfileTitle": "编辑我的资料——照片、名字、简介、本房间图片",
    "cmd.editProfile": "编辑我的资料",
    "cmd.yourProfile": "你的资料",
    "side.people": "房间里的人",
    "side.you": "这是你",
    "side.youTag": "（你）",
    "side.you2": "你",
    "side.viaSite": "经由站点",
    "side.dmTitle": "与 {n} 私聊",
    "side.dm": "⇄ 私聊",
    "side.dms": "私聊",
    "side.unread": "{n} 条未读",
    "side.invited": "已邀请",
    "side.justTwo": "只有你们两个",
    "tb.private": "私聊",
    "tb.dmSub": "两人都离开后即消失 · 由只有你们两个持有的密钥密封",
    "tb.back": "返回房间（Esc）",
    "tb.backBtn": "‹ 房间",
    "tb.peopleTitle": "本房间的人",
    "tb.inRoom": "房间内 {n} 人",
    "tb.warpTitle": "把这里的所有人迁移到新宇宙——这个词之后将为下一位输入它的人开启一间全新房间",
    "tb.warp": "✦ 跃迁",
    "tb.inviteTitle": "复制一个可打开本房间的链接——房间词已包含在内",
    "tb.invite": "＋ 邀请",
    "hint.earthAlone": `你在 earth——每个使用这个词的人都会进入这间房间。打个招呼，或者<button id="p-invite-empty" class="linklike">邀请朋友</button>。`,
    "hint.earthOthers": "你在 earth——每个使用这个词的人都会进入这间房间。打个招呼。",
    "hint.wordAlone": `还没有其他人用过这个词——有人输入相同的词时会立刻来到这里。<button id="p-invite-empty" class="linklike">邀请一个人</button>`,
    "hint.wordOthers": "你已进入——只有输入过本房间词的人才会在这里。",
    "hint.dm": "这是一间密封的二人房间——只有你和 {n} 持有这把钥匙。",
    "hint.keepOpen": "请保持此标签页打开——对方一使用相同的词就会来到这里。手机锁屏时标签页会暂停；拿起手机即可立刻重连。",
    "iq.readingFile": "正在读取文件…",
    "iq.shrinking": "正在把图片压缩到 30 KB…",
    "iq.ready": "就绪——按 Enter 发送",
    "iq.sentAsIs": "原样发送",
    "iq.metaKept": "保留元数据",
    "iq.enterSends": "按 Enter 发送",
    "iq.removeImg": "移除图片",
    "iq.removeFile": "移除文件",
    "cp.emojiTitle": "插入表情",
    "cp.attachTitle": "附加图片或文件——图片会在你的设备上重新编码到 30 KB 以内（EXIF 一并去除）；不超过 30 KB 的文件原样传输",
    "cp.attachAria": "附加图片或文件",
    "cp.caption": "说明文字（可选）…",
    "cp.dmPh": "私聊消息…（按 Enter 发送）",
    "cp.roomPh": "发送到房间…（按 Enter 发送）",
    "cp.sendTitle": "Enter 发送 · Shift+Enter 换行",
    "cp.send": "发送",
    "msg.viaTitle": "经端到端密封、通过站点中转邮箱送达",
    "msg.imgAlt": "共享的图片",
    "msg.fileTitle": "下载——端到端密封，在你的设备上解码",
    "msg.webFile": "网页文件——小心",
    "msg.download": "下载",
    "msg.you": "你",
    "msg.reactTitle": "回应这条消息",
    "msg.reactAria": "添加回应",
    "pf.sheetAria": "编辑我的资料",
    "pf.title": "你的资料",
    "pf.photo": "照片…",
    "pf.remove": "移除",
    "pf.name": "名字",
    "pf.bio": "简介",
    "pf.bioPh": "一句关于你的介绍——房间里的其他人可见",
    "pf.roomTitle": "本房间的图片",
    "pf.picture": "图片…",
    "pf.cancel": "取消",
    "pf.save": "保存",
    "pf.note": "这里的所有内容仅限本次会话——以密封方式发给房间里的人，标签页关闭后即消失。不会在任何地方存储。",
    "menu.buildHeader": "{n} · 网页版构建 {b}",
    "menu.logoff": "退出",
    "menu.logoffHint": "返回加入界面——你的密钥仍保留在此浏览器中",
    "menu.browserLine": "{b} · Enter 发送，Shift+Enter 换行",
    "menu.lang": "语言 / Language",
    "menu.langHintEn": "切换到简体中文",
    "menu.langHintZh": "切换到 English",
    "menu.warpQ": "跃迁到宇宙 {n}？",
    "menu.warpGo": "✦ 跃迁",
    "menu.warpHint": "这里的所有人换用新密钥；该词将为后来者另开一间新房间",
    "menu.stay": "留在这里",
    "menu.stayHint": "宇宙 {n} 继续",
    "menu.switch": "切换对话",
    "menu.peopleRoom": "房间里的人 · {w}",
    "menu.thisDeviceHost": "此设备——正保持房间开放",
    "menu.thisDevice": "此设备",
    "menu.holdingOpen": "正保持房间开放",
    "menu.startDm": "开始一场私聊",
    "menu.dms": "私聊",
    "menu.roomEpoch": "{w} · 宇宙 {e}",
    "emj.faces": "表情", "emj.hands": "手势", "emj.hearts": "爱心",
    "emj.nature": "自然", "emj.animals": "动物", "emj.food": "食物",
    "emj.play": "玩乐", "emj.travel": "旅行", "emj.things": "物品",
    "emj.signs": "符号", "emj.recent": "最近", "emj.react": "回应",
    "emj.more": "更多表情",
  },
};

let LANG: Lang = (() => {
  try {
    const s = localStorage.getItem("oh-lang");
    if (s === "zh" || s === "en") return s;
  } catch { /* private mode — fall through to detection */ }
  return /^zh\b/i.test(navigator.language || "") ? "zh" : "en";
})();

function setLang(lang: Lang) {
  LANG = lang;
  try { localStorage.setItem("oh-lang", lang); } catch { /* fine */ }
  render();
}

function t(key: string, params?: Record<string, string | number>): string {
  let s = STR[LANG][key] ?? STR.en[key] ?? key;
  if (params) for (const k in params) s = s.split("{" + k + "}").join(String(params[k]));
  return s;
}

/** A reaction frame's validated body: react to `s`'s message number `q`
 *  with `e` (x = remove mine). The reactor is always the FRAME sender —
 *  the body only selects the target, so attribution can't be forged. */
interface ReactBody { s: string; q: number; e: string; x: boolean }

interface Msg {
  ts: number; sender: string; name: string; body: string; out: boolean;
  /// The frame's wire seq — with `sender`, the message identity reactions
  /// target (unique per sender, replay-guarded by seenSeq).
  q?: number;
  img?: ImgMsg; file?: FileMsg;
  /// Live reactions: emoji → set of reacting peer ids. Exactly as
  /// ephemeral as the message it hangs on — dies with its room/DM.
  re?: Map<string, Set<string>>;
}

/** One ephemeral two-person room (mirrors core rooms.rs DmRoom): a random
 *  key only the two peers hold, memory-only, never rotated, delivered
 *  sealed and never fanned out. */
interface DmState {
  peer: string;
  crypto: RoomCrypto;
  mySeq: number;
  seenSeq: number;
  /// Frames we sealed under our current key — drives split-brain adoption.
  sent: number;
  /// True until an inbound frame proves the peer holds our key; the invite
  /// rides along with every send while set (covers a peer that refreshed).
  unconfirmed: boolean;
  msgs: Msg[];
  unread: number;
}

/** One line of the connection log — every discovery/seating attempt the
 *  tab makes, so two clients that can't see each other are debuggable at
 *  a glance instead of staring at a spinner. */
interface ConnEvent { ts: number; text: string; kind: "try" | "ok" | "warn" }

// ---------------------------------------------------------------- images
// Inline tier (docs/image-sharing-study.md): every image is re-encoded ON
// THE DEVICE down to IMG_BUDGET bytes, so the sealed frame it rides stays
// under the hub's 64 KB env_json cap with zero hub changes. Re-encoding
// also strips EXIF/GPS — originals never leave the device. Body format on
// the wire: {"ohimg":{"d","w","h","m"},"t":"caption"} as a Chat frame with
// exact (non-bucket) padding; text-only messages keep the raw-text body of
// every shipped client.

// Files ride the SAME inline tier and the same 30 KB budget — but bytes
// travel as-is (no canvas re-encode exists for arbitrary files), so the
// raw size is checked up front instead: 30 KB → ~41 KB of base64 → the
// identical envelope arithmetic an image frame already fits. Wire format:
// {"ohfile":{"d","n","m","s"},"t":"caption"}. Files are never rendered —
// only downloadable via a lazily built blob URL — so content can't execute
// on receipt. Note the privacy difference: an image is re-encoded (EXIF
// gone), a file arrives byte-for-byte, metadata included.

interface ImgPayload { d: string; w: number; h: number; m: string }
interface ImgMsg { src: string; w: number; h: number }
interface PendingImg extends ImgPayload { src: string; bytes: number }

interface FilePayload { d: string; n: string; m: string; s: number }
/** A file frame rendered in a chat — `id` maps the DOM chip back to the
 *  bytes; the blob URL is minted on first click, never at render. */
interface FileMsg extends FilePayload { id: string; url?: string }
interface PendingFile extends FilePayload { }

const fileById = new Map<string, FileMsg>();
let fileSeq = 0;
function mintFileMsg(p: FilePayload): FileMsg {
  const m: FileMsg = { ...p, id: `f${Date.now().toString(36)}${++fileSeq}` };
  fileById.set(m.id, m);
  return m;
}

/** Room switch / log-off: the messages that referenced these chips are
 *  gone, so drop the bytes and revoke any minted blob URLs. */
function clearFileMsgs() {
  for (const f of fileById.values()) if (f.url) URL.revokeObjectURL(f.url);
  fileById.clear();
}

/** A peer-supplied filename never touches the filesystem as a path — it is
 *  display text and a `download` hint — but keep it sane anyway: last path
 *  segment, no control chars, bounded. */
function safeFileName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/\\/g, "/").split("/").pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, 80);
}

/** Mime types are only a Blob `type` hint on download; still refuse
 *  anything but a well-formed type/subtype pair. */
function safeMime(s: unknown): string {
  return typeof s === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,99}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,99}$/i.test(s)
    ? s.toLowerCase() : "application/octet-stream";
}

/// Types that execute when the recipient opens the saved file — the chip
/// labels them so a "30 KB download" never hides a web page.
const ACTIVE_TYPES = new Set(["text/html", "image/svg+xml", "application/xhtml+xml"]);

const IMG_BUDGET = 30 * 1024;
const FILE_BUDGET = IMG_BUDGET; // same inline-tier limit, enforced on the raw bytes
const IMG_EDGES = [1280, 1024, 880, 720, 560, 440, 320];
/// Avatars (profile + room images) render at ≤52 px but may be viewed
/// larger: a 320 px re-encode under 8 KB is crisp everywhere and keeps a
/// full profile frame (photo + bio + name) far inside the mail cap.
const AVATAR_BUDGET = 8 * 1024;
const AVATAR_EDGES = [320, 256, 192, 160, 128];

let pendingImg: PendingImg | null = null;
let pendingFile: PendingFile | null = null;
let convertingWhat = "";
let convertingKind: "img" | "file" = "img";

function payloadToImg(p: ImgPayload): ImgMsg {
  return { src: `data:${p.m};base64,${p.d}`, w: p.w, h: p.h };
}

/** Standard base64 of a Blob via its data URL (FileReader emits standard
 *  alphabet — the protocol's b64() is the URL-safe one, so keep these two
 *  worlds separate: `d` is only ever consumed by <img src=data:…>). */
function blobToStdB64(blob: Blob): Promise<string> {
  return new Promise((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => err(r.error ?? new Error("could not read the encoded image"));
    r.readAsDataURL(blob);
  });
}

async function canvasToBlob(canvas: HTMLCanvasElement, mime: string, q: number): Promise<Blob | null> {
  return new Promise((ok) => canvas.toBlob(ok, mime, q));
}

/** Detect once whether toBlob actually encodes WebP — Safari silently
 *  returns PNG instead, and PNG at these dimensions would blow the budget
 *  for no quality win. */
let webpOk: Promise<boolean> | null = null;
function canWebp(): Promise<boolean> {
  webpOk ??= (async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const b = await canvasToBlob(c, "image/webp", 0.5);
    return !!b && b.type === "image/webp";
  })();
  return webpOk;
}

/** The automatic converter: decode, then walk a resolution × quality
 *  ladder until the re-encode fits the budget. Typical phone photos land
 *  at 880–1024 px WebP; every step costs one fast canvas encode. */
async function fileToImagePayload(file: Blob, budget = IMG_BUDGET, edges: number[] = IMG_EDGES): Promise<PendingImg> {
  const bmp = await createImageBitmap(file); // throws on undecodable (HEIC in Chrome)
  const mime = (await canWebp()) ? "image/webp" : "image/jpeg";
  for (const edge of edges) {
    const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // JPEG has no alpha: flatten onto the inbound bubble colour so
    // transparent PNGs don't turn black.
    ctx.fillStyle = "#1d313c";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    for (const q of [0.75, 0.62, 0.5, 0.4]) {
      const blob = await canvasToBlob(canvas, mime, q);
      if (blob && blob.type === mime && blob.size <= budget) {
        const d = await blobToStdB64(blob);
        return { d, w, h, m: mime, src: `data:${mime};base64,${d}`, bytes: blob.size };
      }
    }
  }
  throw new Error("shrink");
}

type PickTarget = "chat" | "avatar" | "room";

async function pickImage(file: Blob | null | undefined, what: PickTarget = "chat") {
  if (!file || convertingWhat) return;
  convertingWhat = what;
  convertingKind = "img";
  if (what === "chat") { pendingImg = null; pendingFile = null; }
  render();
  try {
    const p = what === "chat"
      ? await fileToImagePayload(file)
      : await fileToImagePayload(file, AVATAR_BUDGET, AVATAR_EDGES);
    if (what === "chat") pendingImg = p;
    else if (what === "avatar") avatarDraft = p;
    else roomDraft = p;
  } catch {
    // Undecodable-but-small (HEIC on Chrome, say): the bytes can still
    // travel as a file. No re-encode happened, so unlike the image ladder
    // the metadata (EXIF, location) stays in — the warning is explicit.
    if (what === "chat" && file.size <= FILE_BUDGET) {
      await pickFileAfterConvert(file);
      toast(t("toast.imgFallback"));
    } else {
      toast(t("toast.imgUnreadable"));
    }
  } finally {
    convertingWhat = "";
    render();
  }
}

/** Queue a small file that just failed the image ladder — shares the
 *  reading path with pickFile but runs inside pickImage's busy state. */
async function pickFileAfterConvert(file: Blob) {
  try {
    pendingFile = { d: await blobToStdB64(file), n: safeFileName((file as File).name) || "file", m: safeMime(file.type), s: file.size };
  } catch { toast(t("toast.fileUnreadable")); }
}

async function pickFile(file: Blob | null | undefined) {
  if (!file || convertingWhat) return;
  if (file.size === 0) { toast(t("toast.fileEmpty")); return; }
  if (file.size > FILE_BUDGET) {
    toast(t("toast.fileBig", { n: (file.size / 1024).toFixed(0) }));
    return;
  }
  convertingWhat = "chat";
  convertingKind = "file";
  pendingFile = null;
  pendingImg = null;
  render();
  try {
    await pickFileAfterConvert(file);
  } finally {
    convertingWhat = "";
    render();
  }
}

/** Inbound body: image frames are JSON with a whitelisted mime and a
 *  standard-b64 `d` (regex-validated so a crafted payload can never break
 *  out of the src attribute); file frames validate the same way plus an
 *  atob round-trip, and their bytes are never rendered — only downloaded;
 *  anything else is plain text as before. */
function parseChatBody(body: string): { text: string; img?: ImgMsg; file?: FileMsg; react?: ReactBody } {
  if (body.startsWith('{"ohimg"')) {
    try {
      const j = JSON.parse(body) as { ohimg?: { d?: unknown; w?: unknown; h?: unknown; m?: unknown }; t?: unknown };
      const im = j.ohimg;
      if (
        im && typeof im.d === "string" && im.d.length > 100 && im.d.length <= 48000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(im.d) &&
        (im.m === "image/jpeg" || im.m === "image/webp")
      ) {
        const dim = (v: unknown) => Math.max(1, Math.min(20000, Math.round(Number(v) || 320)));
        return { text: typeof j.t === "string" ? j.t : "", img: { src: `data:${im.m};base64,${im.d}`, w: dim(im.w), h: dim(im.h) } };
      }
    } catch { /* not an image frame — fall through to text */ }
  }
  if (body.startsWith('{"ohfile"')) {
    try {
      const j = JSON.parse(body) as { ohfile?: { d?: unknown; n?: unknown; m?: unknown; s?: unknown }; t?: unknown };
      const fl = j.ohfile;
      if (
        fl && typeof fl.d === "string" && fl.d.length >= 4 && fl.d.length <= 48000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(fl.d)
      ) {
        atob(fl.d); // throws on any non-quad length — the click-time decode must never fail
        return {
          text: typeof j.t === "string" ? j.t : "",
          file: mintFileMsg({
            d: fl.d,
            n: safeFileName(fl.n) || "file",
            m: safeMime(fl.m),
            s: Math.max(1, Math.min(FILE_BUDGET, Math.round(Number(fl.s) || (fl.d.length * 3) / 4))),
          }),
        };
      }
    } catch { /* not a file frame — fall through to text */ }
  }
  if (body.startsWith('{"ohreact"')) {
    try {
      const j = JSON.parse(body) as { ohreact?: { s?: unknown; q?: unknown; e?: unknown; x?: unknown } };
      const r = j.ohreact;
      if (
        r && typeof r.s === "string" && r.s.length > 0 && r.s.length <= 64 &&
        typeof r.q === "number" && Number.isInteger(r.q) && validEmoji(r.e)
      ) {
        return { text: "", react: { s: r.s, q: r.q, e: r.e, x: r.x === 1 } };
      }
    } catch { /* not a reaction frame — fall through to text */ }
  }
  return { text: body };
}

/** Hard hub rule (api/inbox.ts): env_json ≤ 65536 chars. Refuse to push
 *  anything larger — with the 30 KB budget this never fires; it is the
 *  safety net that keeps a bug from 400ing the whole fan-out batch. */
function mailFits(env: Envelope): boolean {
  return JSON.stringify(env).length <= 65500;
}

const PAPERCLIP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

const FILEICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>`;

/** Decode a file frame's bytes into a blob URL on first click (cached on
 *  the message) — created inside the user gesture, so downloads work in
 *  every browser without ever rendering the content. The blob is typed
 *  octet-stream on purpose: the download always saves, never opens. */
function fileDownloadUrl(f: FileMsg): string {
  if (!f.url) {
    const bin = atob(f.d);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    f.url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  }
  return f.url;
}

function triggerFileDownload(f: FileMsg) {
  const a = document.createElement("a");
  a.href = fileDownloadUrl(f);
  a.download = f.n;
  a.click();
}

// ---------------------------------------------------------------- emojis
// docs/emoji-study.md: two affordances — a composer picker and message
// reactions. Emoji already ride the UTF-8 text path; reactions are Chat
// frames with the {"ohreact":{s,q,e,x?}} body convention (the ohimg/ohfile
// launch pattern: old clients render the JSON as text, ugly and benign).

/// The quick row on a react picker — one tap, the six classics.
const QUICK_REACT = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/// Curated picker set (no country flags — Windows' emoji font ships none,
/// so flags would render as letter pairs on the primary desktop platform).
/// Categories are space-separated single code points (+ VS16 forms only).
const EMOJI_CATEGORIES: Array<[string, string]> = [
  ["faces", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 💩 ☺️ ✨"],
  ["hands", "👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 ✍️ 💅 🤳 🕺 💃 🧘"],
  ["hearts", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💌"],
  ["nature", "🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍃 🍂 🍁 🍄 🐚 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌜 🌚 🌙 ⭐ 🌟 💫 ☄️ 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ ⛄ 🌊 💧 💦 ☔ 🌍 🌎 🌏"],
  ["animals", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🕷️ 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦏 🐪 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🐇 🦔 🐁 🐀"],
  ["food", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾"],
  ["play", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🏒 🏏 🥊 🥋 🎯 🎳 🎮 🕹️ 🎲 🧩 🎨 🖌️ 🖍️ ✏️ ✒️ 🖊️ 🖋️ 📌 📍 📎 ✂️ 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎵 🎶 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎫 🎟️ 🎁 🎈 🎉 🎊 🎆 🎇 🧨"],
  ["travel", "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🛴 🚲 🛵 🏍️ 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ ⚓ ⛽ 🚦 🚧 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🏕️ ⛺ 🌃 🌆 🌇 🌉"],
  ["things", "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📟 📺 📻 🎙️ ⏰ ⏳ ⌛ 📡 🔋 🔌 💡 🔦 🕯️ 🧯 💸 💵 💳 🧾 ✉️ 📧 📨 📩 📤 📥 📦 📫 📮 🗄️ 🗑️ 🔒 🔓 🔏 🔐 🔑 🗝️ 🔨 ⛏️ 🛠️ 🗡️ ⚔️ 🏹 🛡️ 🔧 🔩 ⚙️ 🗜️ ⚖️ 🔗 ⛓️ 🧰 🧲 🧪 🧫 🧬 🔬 🔭 💉 💊 🩹 🩺 🚪 🛏️ 🚽 🚿 🛁 🧼 🧽 🧹 🧺 🧻 🧴 🛒 👑 💎 💰 🎗️"],
  ["signs", "♻️ ⚜️ 🔱 📴 📳 🆚 🆕 🆓 🆒 🆗 🔝 🔜 ☑️ ✔️ ❌ ❗ ❓ ❕ ❔ ⁉️ 💯 ⚠️ 🚭 📵 ❎ ✅ 🌐 💤 ➕ ➖ ➗ ✖️ ♾️ ‼️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔷 🔶 ⬛ ⬜"],
];

/// Session-only recents — in memory, nothing stored anywhere.
const emojiRecents: string[] = [];
function rememberRecent(g: string) {
  const i = emojiRecents.indexOf(g);
  if (i >= 0) emojiRecents.splice(i, 1);
  emojiRecents.unshift(g);
  if (emojiRecents.length > 8) emojiRecents.length = 8;
}

/// Structurally an emoji: 1–8 code points — a pictographic / flag-half /
/// keycap base, then only modifiers (VS16, skin tones, keycap combiner)
/// and ZWJ joins between further bases. `e` is peer-supplied and reaches
/// the DOM, so the shape is checked, never trusted (esc() still runs at
/// the sink — validation is defense in depth, not the only layer).
function validEmoji(s: unknown): s is string {
  if (typeof s !== "string" || !s.length || s.length > 24) return false;
  const cps = [...s];
  if (cps.length > 8) return false;
  const base = (cp: string) =>
    /\p{Extended_Pictographic}/u.test(cp) || /^[\u{1F1E6}-\u{1F1FF}0-9#*]$/u.test(cp);
  const mod = (cp: string) =>
    cp === "\u200D" || cp === "\uFE0F" || /^[\u{1F3FB}-\u{1F3FF}\u20E3\u{1F1E6}-\u{1F1FF}]$/u.test(cp);
  if (!base(cps[0]!)) return false;
  for (let i = 1; i < cps.length; i++) {
    const cp = cps[i]!;
    if (cp === "\u200D") {
      if (i + 1 >= cps.length || !base(cps[i + 1]!)) return false;
      i++;
    } else if (!mod(cp)) return false;
  }
  return true;
}

function closeEmojiPops() {
  document.querySelectorAll(".emojipop").forEach((n) => n.remove());
}

/** Emoji popover: the composer's insert-picker and a message's react
 *  picker share it. Anchored like openMenu (visual-viewport aware) or to a
 *  long-press point; `quick` starts on the six-classics row whose ⋯
 *  expands to the full grid inside the same popover. */
function openEmojiPop(at: HTMLElement | { x: number; y: number }, onPick: (g: string) => void, quick = false) {
  closeMenus();
  closeEmojiPops();
  const p = document.createElement("div");
  p.className = "emojipop";
  let full = !quick;
  const fill = () => {
    const recents = full && emojiRecents.length
      ? `<div class="eg-cat">${t("emj.recent")}</div><div class="eg-row">${emojiRecents.map((g) => `<button type="button" class="eg" data-g="${esc(g)}">${esc(g)}</button>`).join("")}</div>`
      : "";
    p.innerHTML = `
      ${!full ? `<div class="eg-cat">${t("emj.react")}</div>
        <div class="eg-row quick">${QUICK_REACT.map((g) => `<button type="button" class="eg big" data-g="${esc(g)}">${esc(g)}</button>`).join("")}
          <button type="button" class="eg big" data-g="__more" title="${esc(t("emj.more"))}">⋯</button></div>` : ""}
      ${recents}
      ${full ? EMOJI_CATEGORIES.map(([label, glyphs]) =>
        `<div class="eg-cat">${esc(t("emj." + label))}</div><div class="eg-row">${glyphs.split(" ").map((g) => `<button type="button" class="eg" data-g="${esc(g)}">${esc(g)}</button>`).join("")}</div>`).join("") : ""}`;
    p.querySelectorAll<HTMLButtonElement>("button.eg").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const g = b.dataset.g!;
        if (g === "__more") { full = true; fill(); return; }
        closeEmojiPops();
        rememberRecent(g);
        onPick(g);
      });
    });
  };
  fill();
  document.body.appendChild(p);
  // Anchor: under an element, or at a long-press point — clamped to the
  // visible viewport exactly like openMenu (iOS keyboard panning).
  const pan = window.visualViewport?.offsetTop ?? 0;
  const visH = window.visualViewport?.height ?? window.innerHeight;
  const left = at instanceof HTMLElement ? at.getBoundingClientRect().left : at.x - 24;
  const top = at instanceof HTMLElement ? at.getBoundingClientRect().bottom + 6 : at.y + 10;
  p.style.left = Math.max(8, Math.min(left, window.innerWidth - p.offsetWidth - 8)) + "px";
  p.style.top = Math.max(8 + pan, Math.min(top + pan, pan + visH - p.offsetHeight - 8)) + "px";
}

// The composer picker takes pictures AND files: pictures take the
// re-encode ladder, everything else the raw-bytes path (≤30 KB).
const imgInput = document.createElement("input");
imgInput.type = "file";
imgInput.style.display = "none";
document.body.appendChild(imgInput);
imgInput.addEventListener("change", () => {
  const f = imgInput.files?.[0];
  imgInput.value = ""; // allow re-picking the same file
  if (!f) return;
  if (f.type.startsWith("image/")) void pickImage(f);
  else void pickFile(f);
});

function hiddenFilePicker(onPick: (f: Blob) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "file";
  el.accept = "image/*";
  el.style.display = "none";
  document.body.appendChild(el);
  el.addEventListener("change", () => {
    const f = el.files?.[0];
    el.value = "";
    if (f) onPick(f);
  });
  return el;
}
const avatarInput = hiddenFilePicker((f) => void pickImage(f, "avatar"));
const roomImgInput = hiddenFilePicker((f) => void pickImage(f, "room"));

// ------------------------------------------------------------ profiles
// Session-only, room-scoped. Own photo/bio live on the Portal instance;
// peers' profiles arrive as sealed Profile frames (see Portal.sendOwnProfile)
// and die with the tab — nothing is stored anywhere.

/// Draft picks inside the profile sheet (null = keep current).
let avatarDraft: PendingImg | null = null;
let roomDraft: PendingImg | null = null;
let avatarRemoved = false;
let roomRemoved = false;
let editingProfile = false;

/** A data URL we are willing to render from a peer: whitelisted mime,
 *  standard-b64 body only, bounded length — this is attribute-injection
 *  defence, same stance as parseChatBody. */
function validImgDataUrl(s: unknown): s is string {
  return typeof s === "string" && s.length <= 16000 &&
    /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s);
}

class Portal {
  hub = new Hub("");
  seed!: Uint8Array;
  peerId!: string;
  pubB64!: string;
  name = "";
  word = "";
  gk!: Uint8Array;
  egk!: Uint8Array;
  roomHex!: string;
  room: RoomCrypto | null = null;
  members = new Map<string, string>();
  isHost = false;
  /// Peer id of the host we are seated with (or seeking a seat from).
  /// Only this peer's KeyDelivery may install or replace our room key.
  hostId = "";
  /// Last time we successfully opened a frame from the host; a member that
  /// stops hearing from a "live" host re-requests a seat (missed rotation).
  lastHostContact = 0;
  mySeq = Date.now();
  seenSeq = new Map<string, number>();
  msgs: Msg[] = [];
  dms = new Map<string, DmState>();
  /// Own profile (session-wide; survives room switches, dies with the tab).
  photo = "";
  bio = "";
  /// Room image: any member may set one; newest (ts, sender) wins. Word
  /// rooms are small trusted groups and this is deliberately temporary.
  roomImg = { img: "", ts: 0, by: "" };
  /// Peers' profiles learned from sealed Profile frames, room-scoped.
  profiles = new Map<string, { name?: string; photo?: string; bio?: string; ts: number }>();
  profSeen = new Map<string, number>();
  profSentTo = new Map<string, number>();
  presenceToken = hex(crypto.getRandomValues(new Uint8Array(16)));
  online = 0;
  status = t("st.starting");
  /// Connection log + attempt bookkeeping, rendered live while we hold
  /// no seat. See ConnEvent.
  events: ConnEvent[] = [];
  seatAttempts = 0;
  lastJoinMailAt = 0;
  lastFoundTry = 0;
  lastRegAt = 0;
  lastBeatAt = 0;
  lastRefreshAt = 0;
  loopStarted = false;
  /// Host-side liveness bookkeeping (docs/member-liveness-study.md):
  /// when we host, lastSeen maps each member to the time of their most
  /// recent inbound frame (any kind — transport signature is the proof),
  /// and `capable` marks members we have seen Ping from. Only capable
  /// members are held to the prune standard: older clients never beat,
  /// and pruning them would churn join/leave forever (they re-seat via
  /// rediscover, silently, every cycle).
  lastSeen = new Map<string, number>();
  capable = new Set<string>();
  lastPingAt = 0;
  lastPruneAt = 0;
  /// Liveness cadence tunables (fields, not consts, so e2e can tighten
  /// them through __ohPortal instead of waiting out real minutes).
  pingEvery = 60_000;
  pruneAfter = 180_000;
  pruneEvery = 15_000;
  /// True after a deliberate log-off: the loops park (no re-seat
  /// attempts, no inbox polling, no presence beats) until the next join.
  left = false;
  /// Last hub contact verdict: null = never checked. Drives the site
  /// chip and the "site not answering" log line on transitions.
  siteOk: boolean | null = null;

  logConn(text: string, kind: ConnEvent["kind"] = "try") {
    this.events.push({ ts: Date.now(), text, kind });
    if (this.events.length > 40) this.events.shift();
    render();
  }

  noteSite(ok: boolean) {
    if (this.siteOk === ok) return;
    this.siteOk = ok;
    this.logConn(ok ? t("log.siteOk") : t("log.siteDown"), ok ? "ok" : "warn");
  }

  get sign() { return (m: Uint8Array) => ed25519.sign(m, this.seed); }

  identity() {
    let seedHex = localStorage.getItem("oh-portal-seed");
    if (!seedHex || seedHex.length !== 64) {
      seedHex = hex(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem("oh-portal-seed", seedHex);
    }
    this.seed = unhex(seedHex);
    this.peerId = peerIdFromPublic(ed25519.getPublicKey(this.seed));
    this.pubB64 = b64(publicKeyProtobuf(ed25519.getPublicKey(this.seed)));
  }

  /// The universe key is fetched once per tab from /api/gk (a function
  /// backed by a Vercel env var, so no key file ever lives in the repo),
  /// kicked off at page load so the round-trip hides behind the user's
  /// typing; join() awaits the same promise instead of a fresh fetch.
  gkPromise: Promise<void> | null = null;

  fetchGk(): Promise<void> {
    this.gkPromise = (async () => {
      const gkRes = await fetch("/api/gk", { cache: "no-cache" });
      if (!gkRes.ok) throw new Error("portal not enabled for this app version yet");
      const gkJ = await gkRes.json();
      this.gk = unb64(gkJ.gk_b64);
    })();
    return this.gkPromise;
  }

  /// Argon2id stretches are memoized per word: re-joining the same word
  /// and the idle warm-up for the pre-filled "earth" reuse the burn.
  stretchCache = new Map<string, Promise<Uint8Array>>();

  stretch(word: string): Promise<Uint8Array> {
    let p = this.stretchCache.get(word);
    if (!p) {
      p = effectiveGk(this.gk, word);
      p.catch(() => this.stretchCache.delete(word));
      this.stretchCache.set(word, p);
    }
    return p;
  }

  /// Everything that needs no user input: identity from localStorage, the
  /// GK fetch, and — idle permitting — the earth stretch. Removes most of
  /// the wait from the common join path.
  prefetch() {
    this.identity();
    void this.fetchGk();
    const warm = () => { if (this.gk) void this.stretch("earth"); };
    if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 300);
  }

  async join(name: string, word: string) {
    this.name = name;
    this.word = word;
    this.left = false;
    this.identity();
    setStatus(t("st.fetchBase"));
    await (this.gkPromise ?? this.fetchGk());
    setStatus(t("st.derive"));
    this.egk = await this.stretch(word);
    this.roomHex = globalRoomHex(this.egk);
    setStatus(t("st.register"));
    // Best-effort first contact. A transient failure here (flaky cellular,
    // a refused request) must not bounce the user back to the gate: the
    // tab stays unseated and the connection loop retries aggressively.
    // Publishing our address and reading the room pointer are independent
    // — ship them as one round-trip instead of two sequential awaits.
    let rec: { host_peer_id: string } | null = null;
    try {
      const [, r] = await Promise.all([
        this.hub.reg(this.peerId, this.pubB64, this.sign).catch(() => {}),
        this.hub.lookupRoom(this.roomHex),
      ]);
      rec = r;
      this.lastRegAt = Date.now();
      this.noteSite(true);
    } catch {
      this.noteSite(false);
      this.logConn(t("log.firstFail"), "warn");
    }
    void this.beat();
    try {
      if (rec && rec.host_peer_id === this.peerId) {
        // Our own record survived a page refresh (key was memory-only and
        // is gone): re-claim it and mint a fresh room — members converge
        // back through their own re-discovery.
        await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        this.found();
      } else if (rec) {
        this.seekSeat(rec.host_peer_id);
      } else {
        const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        if (won) {
          this.found();
        } else {
          const again = await this.hub.lookupRoom(this.roomHex);
          if (again && again.host_peer_id !== this.peerId) {
            this.seekSeat(again.host_peer_id);
          }
        }
      }
    } catch {
      this.logConn(t("log.joinRetry"), "warn");
    }
    this.loop();
  }

  /// Mint a fresh room key and host. (Used at founding and when re-claiming
  /// our own stale record after a refresh — the old key died with the tab.)
  found() {
    this.isHost = true;
    this.hostId = this.peerId;
    this.room = new RoomCrypto(unhex(this.roomHex), 1, crypto.getRandomValues(new Uint8Array(32)));
    this.members = new Map([[this.peerId, this.name]]);
    this.lastSeen.clear();
    this.capable.clear();
    this.lastRefreshAt = Date.now();
    this.seatAttempts = 0;
    this.logConn(t("log.founded"), "ok");
    this.ready();
  }

  /// Ask `host` for a seat. Remember who we asked: only their KeyDelivery
  /// may seat us (anyone holding the GK could otherwise hand us their own
  /// key and hijack the session).
  seekSeat(host: string) {
    this.isHost = false;
    this.hostId = host;
    this.seatAttempts++;
    this.lastJoinMailAt = Date.now();
    setStatus(t("st.askSeat", { h: host.slice(0, 8), n: this.seatAttempts }));
    this.logConn(t("log.seatAsk", { n: this.seatAttempts, h: host.slice(0, 8) }));
    void this.hub.mailPush(this.peerId, this.pubB64, this.sign, host, [buildJoin(this.roomHex, this.peerId, this.name, this.egk)])
      .catch(() => this.logConn(t("log.seatRefused"), "warn"));
  }

  /// While we hold no room (host died, Join lost to the 32-item inbox cap,
  /// page refreshed): re-run discovery and re-ask until seated. Runs on
  /// the fast connection tick — a phone tab that slept through its host's
  /// reply reconnects in seconds, not at the next 2-minute mark.
  async retryJoin() {
    if (!this.roomHex || !this.egk) return;
    let rec;
    try { rec = await this.hub.lookupRoom(this.roomHex); }
    catch { this.noteSite(false); return; }
    this.noteSite(true);
    try {
      if (!rec) {
        if (Date.now() - this.lastFoundTry < 10_000) return;
        this.lastFoundTry = Date.now();
        this.logConn(t("log.noHost"));
        const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        if (won) this.found();
        return;
      }
      if (rec.host_peer_id === this.peerId) {
        if (Date.now() - this.lastFoundTry < 10_000) return;
        this.lastFoundTry = Date.now();
        await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        this.found();
        return;
      }
      // A new host, or a re-nudge for the same one — the join mail sits
      // in their inbox for 24h, but a fresh one also survives a crowded
      // inbox (only the last 32 items are kept).
      if (rec.host_peer_id !== this.hostId || Date.now() - this.lastJoinMailAt > 15_000) {
        this.seekSeat(rec.host_peer_id);
      }
    } catch { /* retry next cycle */ }
  }

  ready() { this.status = ""; render(); this.profilePush(); }

  /** Display name: a peer's profile name beats the host's (possibly
   *  stale) member list, which beats the raw peer id. */
  displayName(peer: string): string {
    return this.profiles.get(peer)?.name ?? this.members.get(peer) ?? peer.slice(0, 10);
  }

  async beat() {
    this.lastBeatAt = Date.now();
    try {
      this.online = await this.hub.presence(this.presenceToken);
      this.siteOk = true;
    } catch {
      this.siteOk = false; // network-level failure (a refused/429 response still means "up")
      this.online = 0;
    }
  }

  loop() {
    // A log-off → re-join cycle would stack a second set of timers and
    // wake listeners on the same tab; the guards inside each pass make
    // that harmless, but one loop is the contract.
    if (this.loopStarted) return;
    this.loopStarted = true;
    // Mail drain: the hot path — incoming keys, chat, member frames.
    void this.drain();
    const drainTick = () => {
      void this.drain().catch(() => {}).then(() => setTimeout(drainTick, this.room ? 3500 : 2000));
    };
    setTimeout(drainTick, this.room ? 3500 : 2000);

    // Connection tick: discovery / seat-seeking / host refresh every 5s
    // (each action is internally throttled to respect the hub's limits).
    const connTick = () => {
      void this.cycle().catch(() => {}).then(() => setTimeout(connTick, 5000));
    };
    setTimeout(connTick, 2000);

    // Phones suspend background tabs mid-tick — timers freeze for minutes.
    // The moment this tab is visible again (or the network returns), run a
    // full cycle NOW instead of waiting out the 5s/45s timers above.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      void this.drain().catch(() => {});
      void this.cycle().catch(() => {});
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
  }

  /// One connection-maintenance pass. Separate from drain() so wake
  /// events can run it immediately.
  async cycle() {
    if (this.left) return;
    if (!this.room) {
      await this.retryJoin();
    } else if (this.isHost) {
      // Room records live 300s on the hub; refresh at 45s so a phone
      // throttling our timers still keeps the room findable, and a
      // dead-host pointer clears fast once we are really gone. A WARPED
      // host (epoch ≥ 2) deliberately stops refreshing: the word's record
      // lapses and the next person typing it founds the word room fresh —
      // newcomers are handed our successor key directly in the meantime.
      if (this.room!.epoch === 1 && Date.now() - this.lastRefreshAt > 45_000) await this.hostRefresh();
      if (Date.now() - this.lastPruneAt > this.pruneEvery) {
        this.lastPruneAt = Date.now();
        void this.pruneSilent();
      }
    } else {
      if (Date.now() - this.lastHostContact > 45_000) await this.rediscover();
      if (Date.now() - this.lastPingAt > this.pingEvery) this.pingHost();
    }
    // Address registration + presence counter piggyback here. The hub
    // throttles both to one per 30s per peer/token — the 31s guard
    // stays on the good side of that (except the fast beat retry
    // while the site looks down, which the endpoint cheaply refuses).
    if (Date.now() - this.lastRegAt > 31_000) {
      this.lastRegAt = Date.now();
      void this.hub.reg(this.peerId, this.pubB64, this.sign).catch(() => {});
    }
    if (Date.now() - this.lastBeatAt > 31_000 || this.siteOk === false) {
      void this.beat();
    }
  }

  /// Hosts keep the room record alive (the hub lets the current host
  /// refresh). A 409 means a LIVE record names someone else: a member took
  /// over after we looked away, or a fresh room was founded. Yield to the
  /// live record — we stay a member with our key; rediscover() handles
  /// re-seating us on the new host if needed.
  async hostRefresh() {
    this.lastRefreshAt = Date.now();
    try {
      const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
      this.noteSite(true);
      if (won) return;
      const rec = await this.hub.lookupRoom(this.roomHex);
      if (rec && rec.host_peer_id !== this.peerId) {
        this.isHost = false;
        this.logConn(t("log.yieldHost"), "warn");
        this.msgs.push({ ts: Date.now(), sender: "", name: "", body: t("nar.otherHost"), out: false });
      }
    } catch { this.noteSite(false); /* retry next cycle */ }
  }

  // ------------------------------------------------------------- warp
  // The host's "change room key": everyone HERE travels to a new universe
  // (a rotate frame, byte-compatible with the desktop app), while the
  // word deliberately resets — newcomers typing it are seated into a
  // fresh epoch-1 room under a successor key we mint, and once our word
  // record lapses (≤5 min) the first of them takes it over naturally.

  /// Successor room we host for word-newcomers while warped: key minted at
  /// the first warp, members accumulate as they join. We seal their
  /// Members frames under THEIR key; our own id never enters their list.
  successor: { crypto: RoomCrypto; key: Uint8Array; seq: number; peers: Map<string, string> } | null = null;

  async warp() {
    if (!this.room || !this.isHost || this.room.epoch < 1) return;
    const secret = { next_epoch: this.room.epoch + 1, next_key_b64: b64(crypto.getRandomValues(new Uint8Array(32))) };
    this.mySeq++;
    const frame = this.room.seal(this.peerId, this.mySeq, KIND.rotate, utf8(JSON.stringify(secret)));
    if (!mailFits({ Rotate: { frame } })) return;
    this.room.applyRotation(secret);
    this.lastHostContact = Date.now();
    this.msgs.push({ ts: Date.now(), sender: "", name: "", body: t("nar.warped", { e: this.room.epoch }), out: false });
    this.logConn(t("log.warped", { e: this.room.epoch }), "ok");
    render();
    await this.fanOut({ Rotate: { frame } });
  }

  /// A word-newcomer knocked while we hold a warped room: seat them (and
  /// re-seat returners) into the successor universe with the full successor
  /// member list, and keep every other successor's list current.
  async seatSuccessor(peer: string, name: string) {
    if (!this.room || this.room.epoch < 2) return;
    if (!this.successor) {
      const key = crypto.getRandomValues(new Uint8Array(32));
      this.successor = { crypto: new RoomCrypto(unhex(this.roomHex), 1, key), key, seq: Date.now(), peers: new Map() };
    }
    this.successor.peers.set(peer, name || peer.slice(0, 10));
    const list = [...this.successor.peers.entries()].map(([p, n]) => ({ peer: p, name: n }));
    const kd: Envelope = {
      KeyDelivery: {
        room_id_hex: this.roomHex,
        epoch: 1,
        key_ct_b64: b64(sealRoomKey(this.egk, this.successor.crypto.roomId, 1, peer, this.successor.key)),
        members: list,
      },
    };
    const batch: Array<{ to: string; env: Envelope }> = [{ to: peer, env: kd }];
    if (this.successor.peers.size > 1) {
      this.successor.seq++;
      const mf = this.successor.crypto.seal(this.peerId, this.successor.seq, KIND.members,
        utf8(JSON.stringify({ members: list })));
      for (const p of this.successor.peers.keys()) if (p !== peer) batch.push({ to: p, env: { Members: { frame: mf } } });
    }
    this.logConn(t("log.successor", { n: name || peer.slice(0, 8), e: this.room.epoch }), "ok");
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  /// A member whose host vanished (tab closed, app gone past the record
  /// TTL) would otherwise sit in a dead room forever. Record gone → we take
  /// over hosting with the key we already hold (same room, same epoch).
  /// Record held by someone else (unknown, or our known host has gone quiet
  /// — e.g. we missed a key rotation) → prove GK knowledge and (re)take a
  /// seat; the host's KeyDelivery restores the current key.
  async rediscover() {
    let rec;
    try { rec = await this.hub.lookupRoom(this.roomHex); }
    catch { this.noteSite(false); return; }
    this.noteSite(true);
    if (!rec) {
      try {
        if (Date.now() - this.lastFoundTry < 10_000) return;
        this.lastFoundTry = Date.now();
        const won = await this.hub.registerRoom(this.roomHex, this.peerId, this.pubB64, this.sign);
        if (won) {
          // Sanitize the inherited list: the old host is provably gone
          // (their record lapsed under them) — retire their name instead
          // of pinning the ghost forever. Everyone else is presumed alive
          // from now; their beats re-establish the prune standard.
          const oldHost = this.hostId;
          this.isHost = true; // keep our RoomCrypto: same key, same epoch
          this.hostId = this.peerId;
          this.lastRefreshAt = Date.now();
          this.status = "";
          const now = Date.now();
          if (oldHost && oldHost !== this.peerId && this.members.has(oldHost)) {
            const name = this.members.get(oldHost) ?? oldHost.slice(0, 10);
            this.members.delete(oldHost);
            this.lastSeen.delete(oldHost);
            this.msgs.push({ ts: now, sender: "", name: "", body: t("nar.drifted", { n: name }), out: false });
          }
          for (const p of this.members.keys()) if (!this.lastSeen.has(p)) this.lastSeen.set(p, now);
          this.logConn(t("log.takeover"), "ok");
          this.msgs.push({ ts: now, sender: "", name: "", body: t("nar.hostLeft"), out: false });
        }
      } catch { /* retry next cycle */ }
      return;
    }
    const holder = rec.host_peer_id;
    const healthy = this.members.has(holder) && Date.now() - this.lastHostContact < 300_000;
    if (healthy) return; // host still known and talking to us
    if (Date.now() - this.lastJoinMailAt < 15_000) return; // a request is already in flight
    this.seekSeat(holder);
  }

  async drain() {
    if (this.left) return;
    let items;
    try { items = await this.hub.mailDrain(this.peerId, this.sign); } catch { return; }
    for (const item of items) {
      let from: string;
      try { from = verifyMailItem(item); } catch { continue; }
      let env: Envelope;
      try { env = JSON.parse(item.env_json); } catch { continue; }
      try { this.handle(from, env); } catch (e) { console.warn("envelope", e); }
    }
    if (items.length) render();
  }

  handle(from: string, env: Envelope) {
    // Host-side liveness: any verified inbound frame is proof of life for
    // its sender (the mail signature already authenticated them — the
    // sealed frames below additionally prove key possession, but pruning
    // only needs "this peer is still out there").
    if (this.isHost && from !== this.peerId) this.lastSeen.set(from, Date.now());
    if ("KeyDelivery" in env) {
      const kd = env.KeyDelivery;
      if (kd.room_id_hex !== this.roomHex || this.isHost) return;
      // Only the host we deliberately asked may seat or re-key us: the GK
      // (public for earth) lets anyone SEAL a key, so an unrestricted
      // handler would let a stranger replace our room key and hijack the
      // session. A seated delivery always adopts the host's current
      // key/epoch (missed rotations, takeover forks).
      if (!this.hostId || from !== this.hostId) return;
      if (!Number.isInteger(kd.epoch) || kd.epoch < 1) return;
      if (this.room && kd.epoch < this.room.epoch) return; // no regression
      const key = openRoomKey(this.egk, unhex(this.roomHex), kd.epoch, this.peerId, unb64(kd.key_ct_b64));
      this.room = new RoomCrypto(unhex(this.roomHex), kd.epoch, key);
      this.members = new Map(kd.members.map((m) => [m.peer, m.name]));
      this.mySeq = Date.now();
      this.lastHostContact = Date.now();
      this.lastPingAt = 0; // beat immediately: the host's prune clock starts at our Join
      this.seatAttempts = 0;
      this.status = "";
      this.logConn(t("log.seatedBy", { h: from.slice(0, 8), e: kd.epoch }), "ok");
      this.profilePush(); // introduce ourselves to the room we just joined
      return;
    }
    if ("Chat" in env) {
      // DM frames belong to a different room id: route before any
      // main-room state checks (a DM works even while unseated).
      if (env.Chat.frame.room_id_hex !== this.roomHex) {
        this.handleDmChat(from, env.Chat.frame);
        return;
      }
      if (!this.room) return;
      if (env.Chat.frame.epoch > this.room.epoch) { void this.resync(); return; }
      const body = fromUtf8(this.room.open(env.Chat.frame, KIND.chat));
      if (from === this.hostId) this.lastHostContact = Date.now();
      const sender = env.Chat.frame.sender;
      const seq = env.Chat.frame.seq;
      if (seq <= (this.seenSeq.get(sender) ?? 0)) return; // replay guard
      this.seenSeq.set(sender, seq);
      const pm = parseChatBody(body);
      if (pm.react) { this.applyReact(this.msgs, sender, pm.react); return; }
      this.msgs.push({ ts: Date.now(), sender, name: this.displayName(sender), body: pm.text, out: false, q: seq, img: pm.img, file: pm.file });
      return;
    }
    if ("Members" in env) {
      if (!this.room) return;
      if (env.Members.frame.epoch > this.room.epoch) { void this.resync(); return; }
      // The member list is host-authoritative: any seated member can
      // seal a Members frame (they hold the room key), so without this
      // check one could rewrite everyone's list.
      if (from !== this.hostId) return;
      const body = fromUtf8(this.room.open(env.Members.frame, KIND.members));
      this.lastHostContact = Date.now();
      const list = (JSON.parse(body) as { members: MemberInfo[] }).members;
      // A list from our host that lacks us = we were pruned for silence
      // (or missed the notice). Drop the seat and re-seek — the host
      // re-admits us with the machinery that already exists.
      if (!this.isHost && !list.some((m) => m.peer === this.peerId)) {
        this.unseat(t("log.reseatList"));
        return;
      }
      this.members = new Map(list.map((m) => [m.peer, m.name]));
      this.profilePush(); // someone new may have arrived
      return;
    }
    if ("Rotate" in env) {
      if (!this.room || this.isHost) return;
      if (from !== this.hostId) return;
      const body = fromUtf8(this.room.open(env.Rotate.frame, KIND.rotate));
      this.room.applyRotation(JSON.parse(body));
      this.lastHostContact = Date.now();
      this.msgs.push({ ts: Date.now(), sender: "", name: "", body: t("nar.warped", { e: this.room.epoch }), out: false });
      return;
    }
    if ("Join" in env) {
      void this.hostHandleJoin(from, env.Join);
      return;
    }
    if ("DmInvite" in env) {
      this.handleDmInvite(from, env.DmInvite);
      return;
    }
    if ("Profile" in env) {
      this.handleProfileFrame(from, env.Profile.frame);
      return;
    }
    if ("Ping" in env) {
      // Liveness beat from a seated member (or a successor-room peer —
      // those seal under the successor key, which no longer opens here;
      // the transport signature is the proof that counts, and lastSeen
      // was already updated at the top of handle()).
      if (!this.isHost) return;
      this.capable.add(from);
      try { this.room!.open(env.Ping.frame, KIND.ping); } catch { /* successor-keyed or stale epoch */ }
      return;
    }
    if ("Leave" in env) {
      if (!this.room) return;
      // A member's Leave removes the sender from every list (the mail
      // signature pins who left); the host re-broadcasts the shrunken
      // list. Our HOST leaving is a different event entirely: drop the
      // seat and re-seek, so we converge on a takeover in seconds.
      if (!this.isHost && from === this.hostId) {
        this.unseat(t("log.reseatLeft"));
        return;
      }
      const name = this.members.get(from) ?? from.slice(0, 10);
      this.members.delete(from);
      this.lastSeen.delete(from);
      this.capable.delete(from);
      this.msgs.push({ ts: Date.now(), sender: "", name: "", body: t("nar.left", { n: name }), out: false });
      if (this.isHost) void this.broadcastMembers();
      return;
    }
    if ("Error" in env) {
      // The host pruned us for silence: drop the seat and re-seek — the
      // retry loop re-admits us through the normal Join path.
      if (env.Error.message === "seat-expired" && !this.isHost && from === this.hostId) {
        this.unseat(t("log.reseatSilent"));
        return;
      }
      // A peer could not open a DM frame (they lost the key to a refresh):
      // re-invite them with our existing key, like the desktop app does.
      const lost = /^unknown-room:([0-9a-f]{32})$/.exec(env.Error.message);
      if (lost && this.dms.has(lost[1]!)) { void this.inviteDm(lost[1]!); return; }
      setStatus(env.Error.message);
    }
  }

  /// We hold an older key than the sender (missed a rotation, or the host
  /// re-keyed via takeover): ask the host for a fresh KeyDelivery.
  resync() {
    if (!this.hostId || this.isHost) return;
    void this.hub.mailPush(this.peerId, this.pubB64, this.sign, this.hostId,
      [buildJoin(this.roomHex, this.peerId, this.name, this.egk)]).catch(() => {});
  }

  async hostHandleJoin(from: string, j: Extract<Envelope, { Join: unknown }>["Join"]) {
    if (!this.isHost || !this.room) return;
    if (j.room_id_hex !== this.roomHex || j.guest_id !== from) return;
    // A warped room (epoch ≥ 2) no longer admits word-newcomers into OUR
    // universe — hand them the successor room instead, so the word keeps
    // working for whoever types it next.
    if (this.room.epoch > 1 && !this.members.has(from)) {
      // The admission proof still gates the successor seat: only people
      // who know the word (or GK on earth) may take it.
      const nonce = unb64(j.guest_nonce_b64);
      const expect = admissionProof(this.egk, j.guest_id, nonce);
      const got = unb64(j.guest_proof_b64);
      let diff = 0;
      if (expect.length !== got.length) return;
      for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ got[i];
      if (diff !== 0) return;
      void this.seatSuccessor(from, j.name);
      return;
    }
    const nonce = unb64(j.guest_nonce_b64);
    const expect = admissionProof(this.egk, j.guest_id, nonce);
    const got = unb64(j.guest_proof_b64);
    // Constant-time compare — proof bytes cross the network.
    let diff = 0;
    if (expect.length !== got.length) return; // proof failed
    for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ got[i];
    if (diff !== 0) return; // proof failed
    const isNew = !this.members.has(from);
    this.members.set(from, j.name || from.slice(0, 10));
    // A joiner that announces it beats is held to the prune standard from
    // the Join itself — covers a crash between seat and first Ping (a
    // stale Join re-admitting after a Leave would otherwise ghost
    // forever). Older clients omit the flag and are never pruned.
    if (j.beats === true) this.capable.add(from);
    if (isNew) {
      this.msgs.push({ ts: Date.now(), sender: "", name: "", body: t("nar.joined", { n: j.name || from.slice(0, 10) }), out: false });
      this.logConn(t("log.seatedJoin", { n: j.name || from.slice(0, 8) }), "ok");
    }
    const kd: Envelope = {
      KeyDelivery: {
        room_id_hex: this.roomHex,
        epoch: this.room.epoch,
        key_ct_b64: b64(sealRoomKey(this.egk, this.room.roomId, this.room.epoch, from, this.room.key)),
        members: [...this.members.entries()].map(([peer, name]) => ({ peer, name })),
      },
    };
    const batch: Array<{ to: string; env: Envelope }> = [{ to: from, env: kd }];
    const membersFrame = this.sealMembersFrame();
    if (membersFrame) {
      for (const p of this.members.keys()) if (p !== this.peerId) batch.push({ to: p, env: { Members: { frame: membersFrame } } });
    }
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  sealMembersFrame(): Sealed | null {
    if (!this.room) return null;
    this.mySeq++;
    return this.room.seal(this.peerId, this.mySeq, KIND.members,
      utf8(JSON.stringify({ members: [...this.members.entries()].map(([peer, name]) => ({ peer, name })) })));
  }

  async broadcastMembers() {
    if (!this.room || !this.isHost) return;
    const frame = this.sealMembersFrame();
    if (!frame) return;
    await this.fanOut({ Members: { frame } });
  }

  async fanOut(env: Envelope) {
    const batch = [...this.members.keys()].filter((p) => p !== this.peerId)
      .map((to) => ({ to, env }));
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  // ------------------------------------------------------ member liveness
  // docs/member-liveness-study.md: the member list is "who proved life
  // recently". Members beat to the host; the host prunes silence and
  // notifies the pruned peer, which re-seats itself automatically — so
  // pruning a suspended phone costs one re-join, not a broken session.

  /// Liveness beat: an empty frame sealed under the room key, mailed to
  /// the host only. Sealing matters — it proves we still hold the key,
  /// not just the peer id. The 60s cadence survives Chrome's 1/min
  /// background-tab throttling; a suspended phone stops beating and is
  /// pruned, which is correct — it re-seats the moment it wakes.
  pingHost() {
    if (!this.room || this.isHost || !this.hostId) return;
    this.lastPingAt = Date.now();
    this.mySeq++;
    const frame = this.room.seal(this.peerId, this.mySeq, KIND.ping, utf8("{}"));
    void this.hub.mailPush(this.peerId, this.pubB64, this.sign, this.hostId, [{ Ping: { frame } }]).catch(() => {});
  }

  /// Host: drop members that went silent. Only members we've seen Ping
  /// from are held to the standard — older clients never beat, and
  /// pruning them would churn join/leave forever (they re-seat via
  /// rediscover without ever learning why). The pruned peer is mailed a
  /// seat-expired notice so a waking tab re-seats immediately; everyone
  /// else gets the shrunken list. The successor room (word-newcomers
  /// while we hold a warped room) gets the same silence rule — a pruned
  /// successor heals through its own rediscover re-knock.
  async pruneSilent() {
    if (!this.room || !this.isHost) return;
    const now = Date.now();
    const silent = (p: string): boolean =>
      this.capable.has(p) && (this.lastSeen.get(p) ?? 0) > 0 && now - this.lastSeen.get(p)! > this.pruneAfter;
    const batch: Array<{ to: string; env: Envelope }> = [];
    for (const p of [...this.members.keys()]) {
      if (p === this.peerId || !silent(p)) continue;
      const name = this.members.get(p) ?? p.slice(0, 10);
      this.members.delete(p);
      this.lastSeen.delete(p);
      this.capable.delete(p);
      this.msgs.push({ ts: now, sender: "", name: "", body: t("nar.drifted", { n: name }), out: false });
      batch.push({ to: p, env: { Error: { message: "seat-expired" } } });
    }
    if (this.successor) {
      let cut = false;
      for (const p of [...this.successor.peers.keys()]) {
        if (!silent(p)) continue;
        this.successor.peers.delete(p);
        this.lastSeen.delete(p);
        this.capable.delete(p);
        cut = true;
      }
      if (cut && this.successor.peers.size) {
        const list = [...this.successor.peers.entries()].map(([p, n]) => ({ peer: p, name: n }));
        this.successor.seq++;
        const mf = this.successor.crypto.seal(this.peerId, this.successor.seq, KIND.members,
          utf8(JSON.stringify({ members: list })));
        for (const p of this.successor.peers.keys()) batch.push({ to: p, env: { Members: { frame: mf } } });
      }
    }
    if (!batch.length) return;
    const mf = this.sealMembersFrame();
    if (mf) for (const p of this.members.keys()) if (p !== this.peerId) batch.push({ to: p, env: { Members: { frame: mf } } });
    render();
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  /// Drop our seat locally and let the connection loop seek a fresh one.
  /// Used when the host provably dropped us (seat-expired notice, member
  /// list without us, or the host's own Leave): identity, keys, history
  /// and DMs all survive — retryJoin() re-seats through the normal Join.
  unseat(logText: string) {
    this.room = null;
    this.lastJoinMailAt = 0;
    setStatus(t("st.rejoin"));
    this.logConn(logText, "warn");
  }

  /// Deliberate exit (Log off, or joining a different word): tell the
  /// room we're gone — a member tells its host, a HOST tells every member
  /// (each survivor then re-seats onto a takeover in seconds instead of
  /// waiting out the 5-minute record lapse) — and unseat locally. `gone`
  /// additionally parks the loops and drops us from the site's presence
  /// counter; used when the tab stays open on the gate screen.
  leaveRoom(gone: boolean) {
    if (this.room) {
      if (this.isHost) {
        const batch = [...this.members.keys()].filter((p) => p !== this.peerId)
          .map((to) => ({ to, env: { Leave: { room_id_hex: this.roomHex } } as Envelope }));
        if (batch.length) void this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
      } else if (this.hostId) {
        void this.hub.mailPush(this.peerId, this.pubB64, this.sign, this.hostId,
          [{ Leave: { room_id_hex: this.roomHex } }]).catch(() => {});
      }
    }
    this.room = null;
    this.left = gone;
    if (gone) {
      void fetch("/api/presence", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.presenceToken, leave: true }),
      }).catch(() => {});
      this.msgs = [];
      this.members = new Map();
      this.lastSeen.clear();
      this.capable.clear();
      this.status = "";
      clearFileMsgs(); // file chips die with the room they arrived in
    }
  }

  async send(text: string, img?: ImgPayload, file?: FilePayload) {
    const body = text.trim();
    if (!this.room || (!body && !img && !file)) return;
    this.mySeq++;
    // Wire payloads are exactly {d,w,h,m} / {d,n,m,s}: callers hold richer
    // objects (PendingImg carries src+bytes) — never fold those into frames.
    const frame = img
      ? this.room.seal(this.peerId, this.mySeq, KIND.chat, utf8(JSON.stringify({ ohimg: { d: img.d, w: img.w, h: img.h, m: img.m }, t: body })), true)
      : file
        ? this.room.seal(this.peerId, this.mySeq, KIND.chat, utf8(JSON.stringify({ ohfile: { d: file.d, n: file.n, m: file.m, s: file.s }, t: body })), true)
        : this.room.seal(this.peerId, this.mySeq, KIND.chat, utf8(text));
    if (!mailFits({ Chat: { frame } })) {
      toast(t("toast.mailCap"));
      return;
    }
    this.msgs.push({ ts: Date.now(), sender: this.peerId, name: this.name, body, out: true, q: this.mySeq, img: img ? payloadToImg(img) : undefined, file: file ? mintFileMsg(file) : undefined });
    render();
    await this.fanOut({ Chat: { frame } });
  }

  /** Fold a reaction frame into the message it names. The target must
   *  already be known locally — late or orphaned reactions (target evicted
   *  with the inbox window) drop silently: reactions are exactly as
   *  ephemeral as the messages they annotate. Caps: ≤24 distinct emoji and
   *  ≤8 live reactions per peer per message, so a hostile member can bloat
   *  a bubble no further; overflow is ignored without error. */
  applyReact(list: Msg[], from: string, r: ReactBody) {
    const m = list.find((x) => x.sender === r.s && x.q === r.q);
    if (!m) return;
    if (r.x) {
      m.re?.get(r.e)?.delete(from);
      if (m.re && !m.re.get(r.e)?.size) m.re.delete(r.e);
      return;
    }
    if (!m.re) m.re = new Map();
    if (!m.re.has(r.e) && m.re.size >= 24) return;
    let mine = 0;
    for (const s of m.re.values()) if (s.has(from)) mine++;
    if (mine >= 8 && !m.re.get(r.e)?.has(from)) return;
    const set = m.re.get(r.e) ?? new Set<string>();
    set.add(from);
    m.re.set(r.e, set);
  }

  /** Toggle a reaction on one of this room's messages: a Chat frame with
   *  the {"ohreact":…} body, bucket-padded like short text (same size
   *  class), fanned out exactly like a text message. */
  async react(target: { sender: string; q: number }, e: string, on: boolean) {
    if (!this.room) return;
    this.mySeq++;
    const r: Record<string, unknown> = { s: target.sender, q: target.q, e };
    if (!on) r.x = 1;
    const frame = this.room.seal(this.peerId, this.mySeq, KIND.chat, utf8(JSON.stringify({ ohreact: r })));
    if (!mailFits({ Chat: { frame } })) return;
    this.applyReact(this.msgs, this.peerId, { s: target.sender, q: target.q, e, x: !on });
    render();
    await this.fanOut({ Chat: { frame } });
  }

  // -------------------------------------------------------- own profile

  /** Broadcast this peer's current profile to every room member as a
   *  sealed Profile frame (one batched mail push; photos are small enough
   *  that the whole frame stays far under the hub's env cap). */
  sendOwnProfile(roomImgChanged: boolean) {
    if (!this.room) return;
    this.mySeq++;
    const body: Record<string, unknown> = { n: this.name, p: this.photo, t: Date.now() };
    if (this.bio) body.b = this.bio;
    // Only a deliberate room-image change carries `r` — echoing our last
    // known image with a fresh ts would hijack it from whoever set it.
    if (roomImgChanged) body.r = this.roomImg.img;
    const frame = this.room.seal(this.peerId, this.mySeq, KIND.profile, utf8(JSON.stringify(body)), true);
    const env: Envelope = { Profile: { frame } };
    if (!mailFits(env)) return; // 8 KB avatars always fit; guard is a backstop
    const targets = [...this.members.keys()].filter((p) => p !== this.peerId);
    for (const p of targets) this.profSentTo.set(p, Date.now());
    const batch = targets.map((to) => ({ to, env }));
    if (batch.length) void this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  /** Re-introduce ourselves to members we haven't told recently (seating,
   *  membership changes) — new joiners learn names from the host's member
   *  list and faces/bios from these frames. */
  profilePush() {
    if (!this.room) return;
    const now = Date.now();
    const stale = [...this.members.keys()].some((p) =>
      p !== this.peerId && now - (this.profSentTo.get(p) ?? 0) > 120_000);
    if (stale) this.sendOwnProfile(false);
  }

  /** A peer's sealed Profile frame: merge name/photo/bio, converge the
   *  room image, and (as host) keep the canonical member names fresh so
   *  later joiners hear the current display name from the seat delivery. */
  handleProfileFrame(from: string, frame: Sealed) {
    if (!this.room || frame.room_id_hex !== this.roomHex) return;
    if (frame.epoch > this.room.epoch) { void this.resync(); return; }
    if (frame.seq <= (this.profSeen.get(from) ?? 0)) return; // replay guard
    this.profSeen.set(from, frame.seq);
    if (from === this.hostId) this.lastHostContact = Date.now();
    let j: any;
    try { j = JSON.parse(fromUtf8(this.room.open(frame, KIND.profile))); } catch { return; }
    const prof = this.profiles.get(from) ?? { ts: 0 };
    prof.ts = Number(j.t) || Date.now();
    if (typeof j.n === "string" && j.n.trim()) prof.name = j.n.trim().slice(0, 32);
    if (typeof j.b === "string") prof.bio = j.b.slice(0, 120);
    if (j.p === "" || j.p === undefined) delete prof.photo;
    else if (validImgDataUrl(j.p)) prof.photo = j.p;
    this.profiles.set(from, prof);
    if (this.isHost && prof.name && this.members.get(from) !== prof.name) {
      this.members.set(from, prof.name);
      void this.broadcastMembers();
    }
    if (typeof j.r === "string" && (j.r === "" || validImgDataUrl(j.r))) {
      const t = Number(j.t) || 0;
      if (t > this.roomImg.ts || (t === this.roomImg.ts && from > this.roomImg.by)) {
        this.roomImg = { img: j.r, ts: t, by: from };
      }
    }
  }

  // ------------------------------------------------------ direct messages
  dmHexFor(peer: string): string {
    return dmRoomHex(this.egk, this.peerId, peer);
  }

  /// Open (or re-open) a private chat with `peer`. Idempotent: an existing
  /// room keeps its key; the invite is resent anyway on the next send.
  openDm(peer: string): string {
    const hex = this.dmHexFor(peer);
    if (!this.dms.has(hex)) {
      this.dms.set(hex, {
        peer,
        crypto: new RoomCrypto(unhex(hex), 1, crypto.getRandomValues(new Uint8Array(32))),
        mySeq: Date.now(), seenSeq: 0, sent: 0, unconfirmed: true, msgs: [], unread: 0,
      });
    }
    return hex;
  }

  /// The invite carries BOTH seals: `key_ct_b64` (GK channel — what shipped
  /// desktop apps open, byte-compatible with core rooms.rs) and, while we
  /// hold the room key, a frame sealed UNDER the room key (the strong path:
  /// only current members can open it — the hub never holds that key).
  buildDmInvite(hex: string): Envelope | null {
    const dm = this.dms.get(hex);
    if (!dm) return null;
    const di: { room_id_hex: string; key_ct_b64: string; frame?: Sealed } = {
      room_id_hex: hex,
      key_ct_b64: b64(sealRoomKey(this.egk, dm.crypto.roomId, 1, dm.peer, dm.crypto.key)),
    };
    if (this.room) {
      this.mySeq++;
      di.frame = this.room.seal(this.peerId, this.mySeq, KIND.dminvite,
        utf8(JSON.stringify({ key_b64: b64(dm.crypto.key) })));
    }
    return { DmInvite: di };
  }

  async inviteDm(hex: string) {
    const dm = this.dms.get(hex);
    const inv = this.buildDmInvite(hex);
    if (!dm || !inv) return;
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, [{ to: dm.peer, env: inv }]).catch(() => {});
  }

  async sendDm(hex: string, text: string, img?: ImgPayload, file?: FilePayload) {
    const dm = this.dms.get(hex);
    const body = text.trim();
    if (!dm || (!body && !img && !file)) return;
    dm.mySeq++;
    const frame = img
      ? dm.crypto.seal(this.peerId, dm.mySeq, KIND.chat, utf8(JSON.stringify({ ohimg: { d: img.d, w: img.w, h: img.h, m: img.m }, t: body })), true)
      : file
        ? dm.crypto.seal(this.peerId, dm.mySeq, KIND.chat, utf8(JSON.stringify({ ohfile: { d: file.d, n: file.n, m: file.m, s: file.s }, t: body })), true)
        : dm.crypto.seal(this.peerId, dm.mySeq, KIND.chat, utf8(text));
    if (!mailFits({ Chat: { frame } })) {
      toast(t("toast.mailCap"));
      return;
    }
    // Count the send only now: the split-brain adoption rule keys off
    // frames actually sent under our key.
    dm.sent++;
    dm.msgs.push({ ts: Date.now(), sender: this.peerId, name: this.name, body, out: true, q: dm.mySeq, img: img ? payloadToImg(img) : undefined, file: file ? mintFileMsg(file) : undefined });
    render();
    const batch: Array<{ to: string; env: Envelope }> = [{ to: dm.peer, env: { Chat: { frame } } }];
    if (dm.unconfirmed) {
      const inv = this.buildDmInvite(hex);
      if (inv) batch.unshift({ to: dm.peer, env: inv });
    }
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  /** Same toggle inside a private chat — one recipient, the same
   *  disciplines as sendDm: `sent` counts only frames that passed the
   *  guard, and the invite still rides along while unconfirmed. A
   *  reaction never bumps the unread counter on either side. */
  async reactDm(hex: string, target: { sender: string; q: number }, e: string, on: boolean) {
    const dm = this.dms.get(hex);
    if (!dm) return;
    dm.mySeq++;
    const r: Record<string, unknown> = { s: target.sender, q: target.q, e };
    if (!on) r.x = 1;
    const frame = dm.crypto.seal(this.peerId, dm.mySeq, KIND.chat, utf8(JSON.stringify({ ohreact: r })));
    if (!mailFits({ Chat: { frame } })) return;
    dm.sent++;
    this.applyReact(dm.msgs, this.peerId, { s: target.sender, q: target.q, e, x: !on });
    render();
    const batch: Array<{ to: string; env: Envelope }> = [{ to: dm.peer, env: { Chat: { frame } } }];
    if (dm.unconfirmed) {
      const inv = this.buildDmInvite(hex);
      if (inv) batch.unshift({ to: dm.peer, env: inv });
    }
    await this.hub.mailPushBatch(this.peerId, this.pubB64, this.sign, batch).catch(() => {});
  }

  /// A Chat frame for a room that is not ours routes to the DM registry.
  /// Unknown id → the peer holds a key we lost (refresh): say so and they
  /// re-invite us (mirrors the Rust unknown-room flow).
  handleDmChat(from: string, frame: Sealed) {
    const dm = this.dms.get(frame.room_id_hex);
    if (!dm) {
      void this.hub.mailPush(this.peerId, this.pubB64, this.sign, from,
        [{ Error: { message: `unknown-room:${frame.room_id_hex}` } }]).catch(() => {});
      return;
    }
    const body = fromUtf8(dm.crypto.open(frame, KIND.chat));
    if (frame.seq <= dm.seenSeq) return; // replay guard (per-DM counter)
    dm.seenSeq = frame.seq;
    dm.unconfirmed = false;
    const pm = parseChatBody(body);
    // A reaction is not a message: fold it into its target and never bump
    // the unread badge. (The unconfirmed flip above already happened — a
    // reaction proves key possession like any frame.)
    if (pm.react) { this.applyReact(dm.msgs, from, pm.react); return; }
    dm.msgs.push({ ts: Date.now(), sender: from, name: this.displayName(from), body: pm.text, out: false, q: frame.seq, img: pm.img, file: pm.file });
    if (activeRoom !== frame.room_id_hex) dm.unread++;
  }

  handleDmInvite(from: string, di: { room_id_hex: string; key_ct_b64: string; frame?: Sealed }) {
    if (di.room_id_hex === this.roomHex) return; // never via DM mechanics
    const roomId = unhex(di.room_id_hex);
    if (roomId.length !== 16) return;
    let key: Uint8Array | null = null;
    if (di.frame && this.room) {
      try {
        const body = fromUtf8(this.room.open(di.frame, KIND.dminvite));
        const k = unb64((JSON.parse(body) as { key_b64: string }).key_b64);
        if (k.length === 32) key = k;
      } catch { /* fall through to the legacy seal */ }
    }
    if (!key) {
      try { key = openRoomKey(this.egk, roomId, 1, this.peerId, unb64(di.key_ct_b64)); }
      catch { return; } // not for us / tampered
    }
    const have = this.dms.get(di.room_id_hex);
    if (have) {
      // Split-brain (both sides minted a key for the same pair): the invite
      // from the smaller peer id wins, but only if we never sent under ours.
      if (have.sent > 0 || from >= this.peerId) return;
    }
    const name = this.members.get(from) ?? from.slice(0, 10);
    this.dms.set(di.room_id_hex, {
      peer: from,
      crypto: new RoomCrypto(roomId, 1, key),
      mySeq: Date.now(), seenSeq: 0, sent: 0, unconfirmed: false,
      msgs: have?.msgs ?? [], unread: have?.unread ?? 0,
    });
    this.logConn(t("log.dmOpened", { n: name }), "ok");
  }
}

// ------------------------------------------------------------------- UI
// Mirrors the desktop app's shell (OnlyHumans-app/src/main.ts render()):
// command bar, sidebar with the room card and member list, chat pane
// with hue-labelled borderless bubbles.

const portal = new Portal();
window.__ohPortal = portal;

// iOS Safari ignores interactive-widget=resizes-content (a Chromium
// feature): the keyboard overlays the layout viewport and pans the
// fixed-inset shell up until the header is off screen and unreachable.
// The visual viewport reports what is actually visible — size the shell
// to it and follow its offset, so the header stays on screen and the
// composer rides just above the keyboard. On Android (which already
// resizes the layout) and desktop this is a no-op.
const vv = window.visualViewport;
if (vv) {
  const fitApp = () => {
    const el = document.getElementById("app");
    if (!el) return;
    el.style.height = `${vv.height}px`;
    el.style.transform = `translateY(${vv.offsetTop}px)`;
  };
  vv.addEventListener("resize", fitApp);
  vv.addEventListener("scroll", fitApp);
  fitApp();
}

function setStatus(s: string) { portal.status = s; render(); }

let view = "gate";
/// Which conversation the chat pane shows: null = the main room, else a
/// DM room hex from portal.dms.
let activeRoom: string | null = null;

/** Stable hue from a peer id — colors avatars and sender labels. */
function peerHue(peer: string): number {
  let h = 0;
  for (let i = 0; i < peer.length; i++) h = (h * 31 + peer.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Round avatar: a profile photo when the peer has one (or the room has
 *  an image), initials otherwise. */
function avatarHtml(peer: string, label: string, photo = ""): string {
  const hue = peerHue(peer);
  if (photo) return `<span class="avatar" style="background:hsl(${hue} 40% 28%)"><img src="${photo}" alt=""></span>`;
  const initials = (label.replace(/\s+/g, "").slice(0, 2) || "?").toUpperCase();
  return `<span class="avatar" style="background:hsl(${hue} 40% 28%);color:hsl(${hue} 70% 75%)">${esc(initials)}</span>`;
}

const photoOf = (peer: string): string =>
  (peer === portal.peerId ? portal.photo : portal.profiles.get(peer)?.photo) || "";
const bioOf = (peer: string): string =>
  (peer === portal.peerId ? portal.bio : portal.profiles.get(peer)?.bio) || "";

/** The room's titlebar glyph: the room image when a member set one, the
 *  mesh glyph otherwise. */
function roomAvatarHtml(): string {
  if (portal.roomImg.img) {
    return `<span class="avatar roomavatar"><img src="${portal.roomImg.img}" alt=""></span>`;
  }
  return MAIN_ROOM_ICON;
}

const MAIN_ROOM_ICON = `<span class="avatar roomavatar">
  <svg viewBox="0 0 24 24" fill="none"><circle cx="6" cy="7" r="2.4" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="8.6" r="2.4" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="17.4" r="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M8.1 7.9 15.9 8.3 M7.3 9 10.6 15.3 M17 10.3 13.9 15.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
</span>`;

/** Keep the composer at one line until it genuinely needs more. */
function autosize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 132) + "px";
}

const isEarth = () => portal.word.trim().toLowerCase() === "earth";
/// The room IS its word — one name everywhere (titlebar, switcher, member
/// header); the generic "Word room"/"Earth room" labels and the pill row
/// are gone per the keep-it-simple pass.
const roomName = () => portal.word;

/** Newest-last slice of the connection log, shown while we hold no seat. */
function connLogHtml(rows = 4): string {
  const slice = portal.events.slice(-rows);
  if (!slice.length) return `<div class="cl-row"><span class="cl-ts">${fmt(Date.now())}</span>${esc(t("log.contact"))}</div>`;
  return slice.map((e) => `<div class="cl-row ${e.kind}"><span class="cl-ts">${fmt(e.ts)}</span>${esc(e.text)}</div>`).join("");
}

/// The invite is a link that pre-fills the room word: /join#room=<word>.
/// The word rides in the HASH so it never leaves the recipient's browser —
/// no server, CDN, or log ever sees it (same rule as the protocol: the
/// word only ever travels inside sealed envelopes).
const inviteUrl = () =>
  `${location.origin}/join#room=${encodeURIComponent(portal.word)}`;

const inviteText = () =>
  t("invite.text", { u: inviteUrl() });

async function copyInvite() {
  const t = inviteText();
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  toast(t("toast.invite"));
}

/// A word arriving via an invite link, read once at boot; it outranks the
/// remembered last room (an explicit link is the fresher intent).
const invitedWord = (() => {
  const h = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  return (new URLSearchParams(h).get("room") ?? "").trim().slice(0, 64);
})();

// The site-wide online counter is a LANDING-page-only fact now — the room
// shows nothing about it. portal.beat() still runs (it IS the counter: the
// tab beats its presence token and beacons a leave on pagehide, keeping
// the public number truthful); we just never display it in the room UI.

function ensureToasts(): HTMLElement {
  let box = document.querySelector<HTMLElement>(".toasts");
  if (!box) {
    box = document.createElement("div");
    box.className = "toasts";
    // Inside the fitted shell, not the body: a body-fixed toast lands
    // behind the open keyboard on iOS.
    (document.getElementById("app") ?? document.body).appendChild(box);
  }
  return box;
}

function toast(text: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  ensureToasts().appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

type MenuItem = { label: string; hint?: string; header?: boolean; icon?: string; act?: () => void };

/** Dropdown menu anchored to a command-bar control. One menu at a time;
 * dismissed by outside click or Escape. */
function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  closeMenus();
  const m = document.createElement("div");
  m.className = "menu";
  m.id = "open-menu";
  for (const it of items) {
    if (it.header) {
      const h = document.createElement("div");
      h.className = "menu-header";
      h.textContent = it.label;
      m.appendChild(h);
      continue;
    }
    const b = document.createElement("button");
    b.className = "menu-item";
    // label/hint are peer-influenced (member names, bios) — escape at the
    // sink; `icon` is the one trusted-HTML parameter (built locally).
    b.innerHTML = `${it.icon ? `<span class="mi-icon">${it.icon}</span>` : ""}
      <span class="mi-text"><span class="mi-label">${esc(it.label)}</span>${it.hint ? `<span class="mi-hint">${esc(it.hint)}</span>` : ""}</span>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      it.act?.();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  // Anchor rects are in visual coords; the fixed menu lives in layout
  // coords. While the iOS keyboard pans the shell (offsetTop > 0), add
  // the pan and clamp to the visible height, not the full window.
  const pan = window.visualViewport?.offsetTop ?? 0;
  const visH = window.visualViewport?.height ?? window.innerHeight;
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = Math.max(8 + pan, Math.min(r.bottom + 6 + pan, pan + visH - m.offsetHeight - 8)) + "px";
}
function closeMenus() { document.getElementById("open-menu")?.remove(); }

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".emojipop")) { closeEmojiPops(); return; }
  if (document.getElementById("open-menu")) { closeMenus(); return; }
  if (editingProfile) { editingProfile = false; avatarDraft = null; roomDraft = null; render(); return; }
  if (activeRoom) { activeRoom = null; render(); }
});
document.addEventListener("click", (e) => {
  const m = document.getElementById("open-menu");
  if (m && !m.contains(e.target as Node)) closeMenus();
  const p = document.querySelector(".emojipop");
  if (p && !p.contains(e.target as Node)) closeEmojiPops();
});

/** One message row — narration lines (empty sender) render centered. */
function msgHtml(m: Msg): string {
  if (!m.sender) return `<div class="narration">${esc(m.body.replace(/^·\s*/, ""))}</div>`;
  const meta = `<div class="meta">${fmt(m.ts)} · <span class="viasite" title="${esc(t("msg.viaTitle"))}">⇄ site</span></div>`;
  const img = m.img
    ? `<img class="msgimg" src="${m.img.src}" style="aspect-ratio:${m.img.w} / ${m.img.h}" alt="${esc(t("msg.imgAlt"))}" loading="lazy">`
    : "";
  // Bytes stay off the DOM — the chip carries only the lookup id; the
  // blob URL is minted inside the click (see the p-msgs click handler).
  const file = m.file
    ? `<button class="msgfile" type="button" data-fid="${m.file.id}" title="${esc(t("msg.fileTitle"))}"><span class="mf-icon">${FILEICON}</span><span class="mf-body"><span class="mf-name">${esc(m.file.n)}</span><span class="mf-meta">${m.file.s < 1024 ? `${m.file.s} B` : `${(m.file.s / 1024).toFixed(1)} KB`} · ${ACTIVE_TYPES.has(m.file.m) ? esc(t("msg.webFile")) : esc(t("msg.download"))}</span></span></button>`
    : "";
  const cap = m.body ? esc(m.body) : "";
  const cls = m.img || m.file ? `msg hasimg${m.file ? " hasfile" : ""}` : "msg";
  // Reactions: one chip per emoji with its count; own reactions carry
  // .mine; the tooltip names the reactors. The ☺ affordance sits at the
  // bubble's corner (hover on pointer devices — touch uses long-press /
  // right-click via the contextmenu handler on the messages pane).
  const myId = portal.peerId;
  const chips = m.re?.size
    ? `<div class="reactions">${[...m.re.entries()].map(([e, set]) =>
        `<button type="button" class="react${set.has(myId) ? " mine" : ""}" data-e="${esc(e)}" title="${esc([...set].map((p) => (p === myId ? t("msg.you") : portal.displayName(p))).join(", "))}">${esc(e)}<span class="re-n">${set.size}</span></button>`).join("")}</div>`
    : "";
  const rbtn = `<button type="button" class="reactbtn" title="${esc(t("msg.reactTitle"))}" aria-label="${esc(t("msg.reactAria"))}">☺</button>`;
  const dat = `data-s="${esc(m.sender)}" data-q="${esc(String(m.q ?? 0))}"`;
  if (m.out) return `<div class="${cls} out" ${dat}>${cap}${img}${file}${meta}${chips}${rbtn}</div>`;
  const hue = peerHue(m.sender);
  return `
    <div class="sender" style="color:hsl(${hue} 65% 70%)">${esc(m.name)}</div>
    <div class="${cls} in" ${dat}>${cap}${img}${file}${meta}${chips}${rbtn}</div>`;
}

/// Unread DMs surface in the tab title — the only channel that signals
/// while another conversation (or another tab) is in front. The base is
/// language-aware (a mid-session switch re-titles the tab).
function syncTitle() {
  const n = [...portal.dms.values()].reduce((s, d) => s + d.unread, 0);
  const base = t("doc.title");
  document.title = n ? `(${n}) ${base}` : base;
}

// ---------------------------------------------------- remembered identity
// Strictly opt-in: with the box checked, the name and the recently used
// room words persist in localStorage so returning visitors skip the
// typing; unchecked scrubs them (the identity seed is separate and always
// stays — it's the keypair, not a preference).

interface Remembered { on: boolean; name: string; last: string; rooms: string[] }

function rememberState(): Remembered {
  try {
    const j = JSON.parse(localStorage.getItem("oh-portal-remember") ?? "null") as Partial<Remembered> | null;
    if (!j || typeof j !== "object") return { on: false, name: "", last: "", rooms: [] };
    return {
      on: j.on === true,
      name: typeof j.name === "string" ? j.name : "",
      last: typeof j.last === "string" ? j.last : "",
      rooms: Array.isArray(j.rooms) ? j.rooms.filter((w): w is string => typeof w === "string").slice(0, 8) : [],
    };
  } catch {
    return { on: false, name: "", last: "", rooms: [] };
  }
}

function saveRemember(on: boolean, name: string, word: string) {
  if (!on) {
    localStorage.removeItem("oh-portal-remember");
    return;
  }
  const prev = rememberState();
  const rooms = [word, ...prev.rooms.filter((w) => w !== word)].slice(0, 8);
  localStorage.setItem("oh-portal-remember", JSON.stringify({ on: true, name, last: word, rooms }));
}

function render() {
  const root = $("app");
  syncTitle();
  if (view === "gate") {
    const rem = rememberState();
    root.innerHTML = `
      <div class="gate">
        <div class="gate-inner">
          <p class="gate-top">${esc(t("gate.top"))}</p>
          <img class="gate-logo" src="/icon-256.png" alt="">
          <h2>${esc(t("gate.slogan"))}</h2>
          <div class="gaterow">
            <input id="p-name" placeholder="${esc(t("gate.namePh"))}" maxlength="32" autocomplete="off" spellcheck="false" value="${esc(rem.on ? rem.name : "")}">
          </div>
          <div class="gaterow">
            <input id="p-word" placeholder="${esc(t("gate.wordPh"))}" maxlength="64" autocomplete="off" spellcheck="false" list="p-rooms" value="${esc(invitedWord || (rem.on ? rem.last : ""))}">
            <button id="p-join" class="primary" type="button">${esc(t("gate.enter"))}</button>
          </div>
          <datalist id="p-rooms">${rem.rooms.map((w) => `<option value="${esc(w)}"></option>`).join("")}</datalist>
          <label class="gaterem" title="${esc(t("gate.rememberTitle"))}">
            <input type="checkbox" id="p-remember" ${rem.on ? "checked" : ""}>
            <span>${esc(t("gate.remember"))}</span>
          </label>
          <p class="gatehint" id="p-err"></p>
          <p class="gatebuild">${esc(t("gate.build", { b: BUILD }))}</p>
          <button id="p-lang" class="gatelang" type="button">${LANG === "zh" ? "English" : "简体中文"}</button>
        </div>
      </div>`;
    const word = $("p-word") as HTMLInputElement;
    $("p-join")?.addEventListener("click", () => void doJoin());
    ($("p-name") as HTMLInputElement).addEventListener("keydown", (e) => { if (e.key === "Enter") void doJoin(); });
    word.addEventListener("keydown", (e) => { if (e.key === "Enter") void doJoin(); });
    $("p-lang")?.addEventListener("click", () => setLang(LANG === "zh" ? "en" : "zh"));
    return;
  }
  // chat view — the desktop app's three-part shell
  // Which private conversation is open (null = the main room).
  const activeDm = activeRoom ? portal.dms.get(activeRoom) ?? null : null;
  const dmName = (peer: string) => portal.displayName(peer);
  // A full re-render fires on every incoming message; keep whatever the
  // user is typing (value + focus) so the composer survives it.
  const prevSend = $("p-send") as HTMLTextAreaElement | null;
  const sendState = prevSend
    ? { value: prevSend.value, focused: document.activeElement === prevSend }
    : null;
  // The profile sheet survives re-renders the same way (a full re-render
  // fires on every incoming message).
  const prevSheetName = $("pf-name") as HTMLInputElement | null;
  const prevSheetBio = $("pf-bio") as HTMLTextAreaElement | null;
  const sheetState = prevSheetName
    ? {
        name: prevSheetName.value,
        bio: prevSheetBio?.value ?? "",
        focusName: document.activeElement === prevSheetName,
        focusBio: document.activeElement === prevSheetBio,
      }
    : null;
  // peerId is unset until portal.join() mints the identity; render runs
  // before that, so fall back to the empty id (hue 0) for the first paint.
  const myId = portal.peerId || "";
  const others = [...portal.members].filter(([p]) => p !== myId);
  const memberCount = portal.members.size || 1;
  root.innerHTML = `
    <header class="cmdbar">
      <img class="brandlogo" src="/icon-256.png" alt="">
      <span class="logo">OnlyHumans</span>
      <span class="roomchip" id="p-roomchip" role="button" tabindex="0" aria-haspopup="menu"
            title="${esc(t("cmd.switchRoom"))}">
        <span class="rs-glyph">${activeDm ? "⇄" : isEarth() ? "⌂" : "◆"}</span>
        <span class="rs-label">${activeDm ? esc(dmName(activeDm.peer)) : esc(roomName())}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </span>
      <button id="p-editprofile" class="profilebtn" title="${esc(t("cmd.editProfileTitle"))}" aria-label="${esc(t("cmd.editProfile"))}">✎<span class="pb-label">${esc(t("cmd.editProfile"))}</span></button>
      <button id="p-idmenu" class="idmenu" title="${esc(t("cmd.yourProfile"))}" aria-haspopup="menu">
        ${avatarHtml(myId, portal.name || t("side.you2"), photoOf(myId))}
        <span class="idname">${esc(portal.name)}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
    </header>
    <main>
      <div class="sidebar">
        <div class="side-label">${esc(t("side.people"))}</div>
        <ul class="member-list">
          <li title="${esc(t("side.you"))}">
            ${avatarHtml(myId, portal.name, photoOf(myId))}
            <div class="li-body">
              <span class="mname">${esc(portal.name)}${esc(t("side.youTag"))}</span>
              <span class="li-sub" title="${esc(portal.bio)}">${esc(portal.bio || t("side.you2"))}</span>
            </div>
          </li>
          ${others.map(([peer]) => `
          <li title="${esc(bioOf(peer))}">
            ${avatarHtml(peer, dmName(peer), photoOf(peer))}
            <div class="li-body">
              <span class="mname">${esc(dmName(peer))}</span>
              <span class="li-sub">${esc(bioOf(peer) || t("side.viaSite"))}</span>
            </div>
            <button class="dm-btn" data-peer="${esc(peer)}" title="${esc(t("side.dmTitle", { n: dmName(peer) }))}" aria-label="${esc(t("side.dmTitle", { n: dmName(peer) }))}">${esc(t("side.dm"))}</button>
          </li>`).join("")}
        </ul>
        ${portal.dms.size ? `
        <div class="side-label">${esc(t("side.dms"))}</div>
        <ul class="member-list dm-list">
          ${[...portal.dms.entries()].map(([hex, dm]) => `
          <li data-dm="${esc(hex)}" class="dmrow ${activeRoom === hex ? "active" : ""}" title="${esc(dmName(dm.peer))}">
            ${avatarHtml(dm.peer, dmName(dm.peer), photoOf(dm.peer))}
            <div class="li-body">
              <span class="mname">${esc(dmName(dm.peer))}</span>
              <span class="li-sub">${dm.unread ? esc(t("side.unread", { n: dm.unread })) : dm.unconfirmed ? esc(t("side.invited")) : esc(t("side.justTwo"))}</span>
            </div>
            ${dm.unread ? `<span class="unread-dot" title="${esc(t("side.unread", { n: dm.unread }))}"></span>` : ""}
          </li>`).join("")}
        </ul>` : ""}
      </div>
      ${(portal.room || activeDm) ? `
      <div class="chat">
        <div class="titlebar">
          ${activeDm ? (() => {
            const n = dmName(activeDm.peer);
            return `
            ${avatarHtml(activeDm.peer, n, photoOf(activeDm.peer))}
            <div class="tb-body">
              <div class="tb-title">${esc(n)} <span class="pp-pill">${esc(t("tb.private"))}</span></div>
              <div class="tb-sub">${esc(t("tb.dmSub"))}</div>
            </div>
            <div class="tb-actions">
              <button id="p-back" class="btn-ghost" title="${esc(t("tb.back"))}">${esc(t("tb.backBtn"))}</button>
            </div>`;
          })() : `
          ${roomAvatarHtml()}
          <div class="tb-body">
            <div class="tb-title">${esc(roomName())}</div>
          </div>
          <div class="tb-actions">
            <button id="p-members" class="btn-ghost members-btn" title="${esc(t("tb.peopleTitle"))}">${esc(t("tb.inRoom", { n: memberCount }))}</button>
            ${portal.isHost ? `<button id="p-warp" class="btn-ghost" title="${esc(t("tb.warpTitle"))}">${esc(t("tb.warp"))}</button>` : ""}
            <button id="p-invite" class="btn-ghost" title="${esc(t("tb.inviteTitle"))}">${esc(t("tb.invite"))}</button>
          </div>`}
        </div>
        <div class="messages" id="p-msgs">
          ${!activeDm && portal.msgs.length === 0 ? `<div class="chat-hint">${isEarth()
            ? (others.length === 0 ? t("hint.earthAlone") : t("hint.earthOthers"))
            : (others.length === 0 ? t("hint.wordAlone") : t("hint.wordOthers"))}</div>` : ""}
          ${activeDm && activeDm.msgs.length === 0 ? `<div class="chat-hint">${t("hint.dm", { n: esc(dmName(activeDm.peer)) })}</div>` : ""}
          ${(activeDm ? activeDm.msgs : portal.msgs).map(msgHtml).join("")}
        </div>
        ${(() => {
          if (!pendingImg && !pendingFile && convertingWhat !== "chat") return "";
          if (convertingWhat === "chat" || (!pendingImg && !pendingFile)) return `
        <div class="imgqueue">
          <span class="spin"></span><span class="iq-meta">${esc(convertingKind === "file" ? t("iq.readingFile") : t("iq.shrinking"))}</span>
        </div>`;
          const pi = pendingImg, pf = pendingFile;
          return `
        <div class="imgqueue">
          ${pi ? `
            <img class="iq-thumb" src="${pi.src}" alt="">
            <span class="iq-meta">${(pi.bytes / 1024).toFixed(1)} KB · ${pi.w}×${pi.h} · ${esc(t("iq.ready"))}</span>
            <button id="p-imgx" class="iq-x" type="button" title="${esc(t("iq.removeImg"))}" aria-label="${esc(t("iq.removeImg"))}">✕</button>` : `
            <span class="iq-ficon">${FILEICON}</span>
            <span class="iq-meta">${esc(pf!.n)} · ${pf!.s < 1024 ? `${pf!.s} B` : `${(pf!.s / 1024).toFixed(1)} KB`} · ${esc(t("iq.sentAsIs"))}${pf!.m.startsWith("image/") ? ` — ${esc(t("iq.metaKept"))}` : ""} — ${esc(t("iq.enterSends"))}</span>
            <button id="p-filex" class="iq-x" type="button" title="${esc(t("iq.removeFile"))}" aria-label="${esc(t("iq.removeFile"))}">✕</button>`}
        </div>`;
        })()}
        <div class="composer">
          <button id="p-emoji" class="attach" type="button" title="${esc(t("cp.emojiTitle"))}" aria-label="${esc(t("cp.emojiTitle"))}">☺</button>
          <button id="p-attach" class="attach" type="button" title="${esc(t("cp.attachTitle"))}" aria-label="${esc(t("cp.attachAria"))}">${PAPERCLIP}</button>
          <textarea id="p-send" rows="1" placeholder="${pendingImg || pendingFile ? esc(t("cp.caption")) : activeDm ? esc(t("cp.dmPh")) : esc(t("cp.roomPh"))}" title="${esc(t("cp.sendTitle"))}" autocomplete="off"></textarea>
          <button id="p-sendbtn" class="primary" type="button">${esc(t("cp.send"))}</button>
        </div>
      </div>` : `
      <div class="empty">
        <div class="join-progress"><span class="spin"></span><span>${esc(portal.status || t("st.finding"))}</span></div>
        <div class="connlog">${connLogHtml()}</div>
        <p class="connhint">${esc(t("hint.keepOpen"))}</p>
      </div>`}
    </main>`;

  // Profile sheet — a modal over the shell (inside #app so the iOS
  // keyboard can't cover it; same pattern as the toasts).
  if (editingProfile) {
    const ownPhoto = avatarDraft?.src ?? (avatarRemoved ? "" : portal.photo);
    const roomPhoto = roomDraft?.src ?? (roomRemoved ? "" : portal.roomImg.img);
    root.insertAdjacentHTML("beforeend", `
      <div class="sheetwrap" id="pf-wrap">
        <div class="sheet" role="dialog" aria-label="${esc(t("pf.sheetAria"))}">
          <div class="sheet-title">${esc(t("pf.title"))}</div>
          <div class="pf-photo">
            ${avatarHtml(portal.peerId || "", portal.name || t("side.you2"), ownPhoto)}
            <div class="pf-photo-btns">
              <button id="pf-photo" type="button">${esc(t("pf.photo"))}</button>
              ${ownPhoto ? `<button id="pf-photo-x" type="button" class="linklike">${esc(t("pf.remove"))}</button>` : ""}
              ${convertingWhat === "avatar" ? `<span class="spin"></span>` : ""}
            </div>
          </div>
          <label class="pf-label" for="pf-name">${esc(t("pf.name"))}</label>
          <input id="pf-name" maxlength="32" autocomplete="off" spellcheck="false" value="${esc(sheetState?.name ?? portal.name)}">
          <label class="pf-label" for="pf-bio">${esc(t("pf.bio"))}</label>
          <textarea id="pf-bio" maxlength="120" rows="2" placeholder="${esc(t("pf.bioPh"))}"></textarea>
          <div class="sheet-title">${esc(t("pf.roomTitle"))}</div>
          <div class="pf-photo">
            ${roomPhoto ? `<span class="avatar roomavatar"><img src="${roomPhoto}" alt=""></span>` : MAIN_ROOM_ICON}
            <div class="pf-photo-btns">
              <button id="pf-room" type="button">${esc(t("pf.picture"))}</button>
              ${roomPhoto ? `<button id="pf-room-x" type="button" class="linklike">${esc(t("pf.remove"))}</button>` : ""}
              ${convertingWhat === "room" ? `<span class="spin"></span>` : ""}
            </div>
          </div>
          <div class="pf-actions">
            <button id="pf-cancel" type="button">${esc(t("pf.cancel"))}</button>
            <button id="pf-save" class="primary" type="button">${esc(t("pf.save"))}</button>
          </div>
          <p class="pf-note">${esc(t("pf.note"))}</p>
        </div>
      </div>`);
    const bioEl = $("pf-bio") as HTMLTextAreaElement | null;
    if (bioEl && sheetState) bioEl.value = sheetState.bio;
    const nameEl = $("pf-name") as HTMLInputElement | null;
    if (nameEl && sheetState?.focusName) nameEl.focus();
    if (bioEl && sheetState?.focusBio) bioEl.focus();
  }

  $("p-idmenu")?.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let the outside-click closer eat this menu
    const el = e.currentTarget as HTMLElement;
    if (document.getElementById("open-menu")) { closeMenus(); return; }
    openMenu(el, [
      { label: t("menu.buildHeader", { n: portal.name, b: BUILD }), header: true },
      {
        label: t("menu.logoff"),
        hint: t("menu.logoffHint"),
        act: () => {
          portal.leaveRoom(true);
          portal.dms.clear();
          activeRoom = null;
          editingProfile = false;
          view = "gate";
          render();
          const n = $("p-name") as HTMLInputElement | null;
          if (n) n.value = portal.name;
        },
      },
      {
        label: t("menu.lang"),
        hint: LANG === "zh" ? t("menu.langHintZh") : t("menu.langHintEn"),
        act: () => setLang(LANG === "zh" ? "en" : "zh"),
      },
      { label: t("menu.browserLine", { b: BROWSER }), header: true },
    ]);
  });
  // The profile sheet got its own always-visible button (user ask: more
  // discoverable than burying it in the identity menu) — left of the menu.
  $("p-editprofile")?.addEventListener("click", () => {
    editingProfile = true;
    avatarDraft = null;
    roomDraft = null;
    avatarRemoved = false;
    roomRemoved = false;
    render();
  });
  $("p-invite")?.addEventListener("click", () => void copyInvite());
  $("p-invite-empty")?.addEventListener("click", () => void copyInvite());

  // Warp is irreversible (the word's public side resets), so it confirms
  // through the same menu language as everything else.
  $("p-warp")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    if (document.getElementById("open-menu")) { closeMenus(); return; }
    const next = (portal.room?.epoch ?? 1) + 1;
    openMenu(el, [
      { label: t("menu.warpQ", { n: next }), header: true },
      {
        label: t("menu.warpGo"),
        hint: t("menu.warpHint"),
        act: () => void portal.warp(),
      },
      { label: t("menu.stay"), hint: t("menu.stayHint", { n: portal.room?.epoch ?? 1 }), act: () => {} },
    ]);
  });

  // Private chats: the ⇄ chip on a member row opens (or re-opens) one and
  // mails the invite; the dm rows switch conversations. Row clicks never
  // start conversations by accident — the chip is the deliberate gesture.
  document.querySelectorAll<HTMLElement>(".sidebar button.dm-btn").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const hex = portal.openDm(b.dataset.peer!);
      activeRoom = hex;
      void portal.inviteDm(hex);
      render();
    });
  });
  document.querySelectorAll<HTMLElement>(".sidebar li.dmrow").forEach((li) => {
    li.addEventListener("click", () => {
      const hex = li.dataset.dm!;
      const dm = portal.dms.get(hex);
      if (!dm) return;
      dm.unread = 0;
      activeRoom = hex;
      render();
    });
  });
  $("p-back")?.addEventListener("click", () => { activeRoom = null; render(); });

  // Profile sheet interactions. Everything applies on Save (Cancel
  // discards); photo picks preview live via avatarDraft/roomDraft.
  $("pf-cancel")?.addEventListener("click", () => {
    editingProfile = false;
    avatarDraft = null;
    roomDraft = null;
    avatarRemoved = false;
    roomRemoved = false;
    render();
  });
  $("pf-photo")?.addEventListener("click", () => avatarInput.click());
  $("pf-photo-x")?.addEventListener("click", () => { avatarDraft = null; avatarRemoved = true; render(); });
  $("pf-room")?.addEventListener("click", () => roomImgInput.click());
  $("pf-room-x")?.addEventListener("click", () => { roomDraft = null; roomRemoved = true; render(); });
  $("pf-wrap")?.addEventListener("click", (e) => {
    if (e.target === $("pf-wrap")) ($("pf-cancel") as HTMLElement).click();
  });
  $("pf-save")?.addEventListener("click", () => {
    const nameEl = $("pf-name") as HTMLInputElement | null;
    const bioEl = $("pf-bio") as HTMLTextAreaElement | null;
    const name = (nameEl?.value ?? "").trim().slice(0, 32);
    const bio = (bioEl?.value ?? "").trim().slice(0, 120);
    if (!name) { toast(t("gate.errName")); return; }
    portal.name = name;
    portal.bio = bio;
    if (avatarDraft) portal.photo = avatarDraft.src;
    else if (avatarRemoved) portal.photo = "";
    const roomChanged = !!(roomDraft || roomRemoved);
    if (roomChanged) {
      portal.roomImg = { img: roomDraft?.src ?? "", ts: Date.now(), by: portal.peerId };
    }
    editingProfile = false;
    avatarDraft = null;
    roomDraft = null;
    avatarRemoved = false;
    roomRemoved = false;
    // Keep the remembered name fresh when remembering is on.
    if (rememberState().on) saveRemember(true, name, rememberState().last || portal.word);
    portal.sendOwnProfile(roomChanged);
    render();
  });

  // The roomchip is the conversation switcher — the phone home of the
  // sidebar's room card + private chats list.
  const chipSwitch = (el: HTMLElement) => {
    if (document.getElementById("open-menu")) { closeMenus(); return; }
    const items: MenuItem[] = [
      { label: t("menu.switch"), header: true },
      {
        label: roomName(),
        icon: roomAvatarHtml(),
        act: () => { activeRoom = null; render(); },
      },
    ];
    for (const [hex, dm] of portal.dms) {
      const n = dmName(dm.peer);
      items.push({
        label: n,
        hint: dm.unread ? t("side.unread", { n: dm.unread }) : dm.unconfirmed ? t("side.invited") : t("side.justTwo"),
        icon: avatarHtml(dm.peer, n, photoOf(dm.peer)),
        act: () => { dm.unread = 0; activeRoom = hex; render(); },
      });
    }
    openMenu(el, items);
  };
  $("p-roomchip")?.addEventListener("click", (e) => { e.stopPropagation(); chipSwitch(e.currentTarget as HTMLElement); });
  $("p-roomchip")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chipSwitch(e.currentTarget as HTMLElement); }
  });

  // Phones fold the sidebar away — this button is the mobile home of the
  // member list (and the room card's word/generation facts).
  $("p-members")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    if (document.getElementById("open-menu")) { closeMenus(); return; }
    const items: MenuItem[] = [
      { label: t("menu.peopleRoom", { w: roomName() }), header: true },
      ...[...portal.members].map(([peer, name]): MenuItem => ({
        label: peer === myId ? `${portal.displayName(peer)}${t("side.youTag")}` : portal.displayName(peer),
        hint: peer === myId
          ? (portal.bio || (portal.isHost ? t("menu.thisDeviceHost") : t("menu.thisDevice")))
          : bioOf(peer) || (peer === portal.hostId ? t("menu.holdingOpen") : t("side.viaSite")),
        icon: avatarHtml(peer, name, photoOf(peer)),
      })),
    ];
    if (others.length) {
      items.push({ label: t("menu.startDm"), header: true });
      for (const [peer, name] of others) {
        items.push({
          label: `⇄ ${portal.displayName(peer)}`,
          icon: avatarHtml(peer, name, photoOf(peer)),
          act: () => { const hex = portal.openDm(peer); activeRoom = hex; void portal.inviteDm(hex); render(); },
        });
      }
    }
    if (portal.dms.size) {
      items.push({ label: t("menu.dms"), header: true });
      for (const [hex, dm] of portal.dms) {
        const n = dmName(dm.peer);
        items.push({
          label: n,
          hint: dm.unread ? t("side.unread", { n: dm.unread }) : dm.unconfirmed ? t("side.invited") : t("side.justTwo"),
          icon: avatarHtml(dm.peer, n, photoOf(dm.peer)),
          act: () => { dm.unread = 0; activeRoom = hex; render(); },
        });
      }
    }
    items.push({ label: t("menu.roomEpoch", { w: portal.word, e: portal.room?.epoch ?? 1 }), header: true });
    openMenu(el, items);
  });

  const ta = $("p-send") as HTMLTextAreaElement | null;
  const sendIt = () => {
    const v = ta!.value.replace(/\s+$/, "");
    if (!v.trim() && !pendingImg && !pendingFile) { ta!.value = ""; autosize(ta!); return; }
    const img = pendingImg ?? undefined;
    const file = pendingFile ?? undefined;
    pendingImg = null;
    pendingFile = null;
    ta!.value = "";
    autosize(ta!);
    if (activeDm && activeRoom) void portal.sendDm(activeRoom, v, img, file);
    else void portal.send(v, img, file);
  };
  if (ta) {
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendIt(); } });
    ta.addEventListener("input", () => autosize(ta));
    // Pasting a screenshot grabs the image; pasting a copied file grabs
    // the file; pasting text still works.
    ta.addEventListener("paste", (e) => {
      const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file");
      const pick = items.find((i) => i.type.startsWith("image/")) ?? items[0];
      const f = pick?.getAsFile();
      if (!f) return;
      e.preventDefault();
      if (f.type.startsWith("image/")) void pickImage(f);
      else void pickFile(f);
    });
    if (sendState) {
      ta.value = sendState.value;
      if (sendState.focused) { ta.focus(); autosize(ta); }
    } else if (!portal.status) {
      ta.focus();
    }
  }
  $("p-sendbtn")?.addEventListener("click", sendIt);
  $("p-attach")?.addEventListener("click", () => imgInput.click());
  // The emoji picker: insert at the caret, never forcing focus (summoning
  // the iOS keyboard from a picker tap is worse than losing the caret).
  $("p-emoji")?.addEventListener("click", (e) => {
    e.stopPropagation(); // the outside-click closer must not eat the popover
    const el = e.currentTarget as HTMLElement;
    if (document.querySelector(".emojipop")) { closeEmojiPops(); return; }
    openEmojiPop(el, (g) => {
      const t = $("p-send") as HTMLTextAreaElement | null;
      if (!t) return;
      const wasFocused = document.activeElement === t;
      t.setRangeText(g, t.selectionStart ?? t.value.length, t.selectionEnd ?? t.value.length, "end");
      autosize(t);
      if (wasFocused) t.focus();
    });
  });
  $("p-imgx")?.addEventListener("click", () => { pendingImg = null; render(); });
  $("p-filex")?.addEventListener("click", () => { pendingFile = null; render(); });

  // One toggle path for reactions, shared by chips and pickers: read the
  // current state off the message (not the DOM class), send add/remove.
  const doReact = (s: string, q: number, e: string) => {
    const list = activeDm ? activeDm.msgs : portal.msgs;
    const m = list.find((x) => x.sender === s && x.q === q);
    const on = !m?.re?.get(e)?.has(portal.peerId);
    if (activeDm && activeRoom) void portal.reactDm(activeRoom, { sender: s, q }, e, on);
    else void portal.react({ sender: s, q }, e, on);
  };
  const openReactPicker = (at: HTMLElement | { x: number; y: number }, s: string, q: number) => {
    openEmojiPop(at, (g) => doReact(s, q, g), true);
  };

  const box = $("p-msgs");
  if (box) {
    box.scrollTop = box.scrollHeight;
    // Long-press state: the timer drives the touch react picker; a fired
    // long-press suppresses the trailing click (so the tapped image under
    // the finger doesn't also open full-size).
    let lpTimer = 0, lpX = 0, lpY = 0, lpFiredAt = 0;
    const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };
    const targetOf = (el: Element): { s: string; q: number } | null => {
      const host = el.closest(".msg");
      const s = host?.getAttribute("data-s") ?? "";
      if (!s) return null;
      return { s, q: Number(host!.getAttribute("data-q")) || 0 };
    };
    // Click a shared file chip to download it — decoded and re-blobbed
    // here, inside the gesture, so no content ever renders inline.
    // Click a shared image to view it full size. The window opens
    // synchronously (popup blockers) and gets a blob URL once decoded.
    // Click a reaction chip to toggle it; the ☺ corner button opens the
    // react picker.
    box.addEventListener("click", (e) => {
      if (Date.now() - lpFiredAt < 600) return; // long-press already acted
      const rb = (e.target as Element).closest("button.react");
      if (rb) {
        const t = targetOf(rb);
        if (t) doReact(t.s, t.q, rb.getAttribute("data-e")!);
        return;
      }
      const ob = (e.target as Element).closest("button.reactbtn") as HTMLElement | null;
      if (ob) {
        e.stopPropagation();
        const t = targetOf(ob);
        if (t) openReactPicker(ob, t.s, t.q);
        return;
      }
      const fb = (e.target as Element).closest("button.msgfile");
      if (fb) {
        const f = fileById.get(fb.getAttribute("data-fid") ?? "");
        if (f) triggerFileDownload(f);
        return;
      }
      const t = e.target as HTMLElement;
      if (t.tagName !== "IMG" || !t.classList.contains("msgimg")) return;
      const w = window.open("", "_blank");
      fetch(t.getAttribute("src")!)
        .then((r) => r.blob())
        .then((b) => {
          const u = URL.createObjectURL(b);
          if (w) w.location.href = u;
          setTimeout(() => URL.revokeObjectURL(u), 60_000);
        })
        .catch(() => w?.close());
    });
    // Right-click a bubble reacts (the native menu stands down); Android
    // and iOS ≥13 also fire contextmenu on long-press, but a pointer
    // timer is the reliable touch path — and it shows mid-press.
    box.addEventListener("contextmenu", (e) => {
      const t = targetOf(e.target as Element);
      if (!t) return;
      e.preventDefault();
      openReactPicker({ x: e.clientX, y: e.clientY }, t.s, t.q);
    });
    box.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return; // hover button + right-click cover mice
      const t = targetOf(e.target as Element);
      if (!t) return;
      lpX = e.clientX; lpY = e.clientY;
      cancelLp();
      lpTimer = window.setTimeout(() => {
        lpTimer = 0;
        lpFiredAt = Date.now();
        openReactPicker({ x: lpX, y: lpY }, t.s, t.q);
      }, 450);
    });
    box.addEventListener("pointermove", (e) => {
      if (lpTimer && (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10)) cancelLp();
    });
    box.addEventListener("pointerup", cancelLp);
    box.addEventListener("pointercancel", cancelLp);
    // Drag-and-drop targets the messages pane (document-level handlers
    // below stop the browser from navigating to the dropped file).
    box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("dropglow"); });
    box.addEventListener("dragleave", () => box.classList.remove("dropglow"));
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("dropglow");
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (f.type.startsWith("image/")) void pickImage(f);
      else void pickFile(f);
    });
  }
}

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function doJoin() {
  const name = ($("p-name") as HTMLInputElement).value.trim();
  const word = ($("p-word") as HTMLInputElement).value.trim() || "earth";
  const err = $("p-err")!;
    if (!name) { err.textContent = t("gate.errName"); return; }
  err.textContent = "";
  saveRemember(($("p-remember") as HTMLInputElement | null)?.checked ?? false, name, word);
  // DM ids and keys bind THIS room's word (egk) — a different room is a
  // different DM space, so private chats never survive a word change.
  // Peers' profiles and the room image are room-scoped the same way; our
  // own photo/bio carry over (they are the user's, not the room's).
  portal.leaveRoom(false); // a deliberate re-join leaves whatever room we held
  portal.dms.clear();
  portal.profiles.clear();
  portal.profSeen.clear();
  portal.profSentTo.clear();
  portal.msgs = [];
  clearFileMsgs();
  portal.roomImg = { img: "", ts: 0, by: "" };
  activeRoom = null;
  editingProfile = false;
  // The chat shell renders before portal.join() runs; seed the fields its
  // first paint reads so the room name and word are right immediately.
  portal.name = name;
  portal.word = word;
  try {
    view = "chat";
    render();
    await portal.join(name, word);
  } catch (e) {
    view = "gate";
    render();
    $("p-err")!.textContent = String(e);
  }
}

// The name is never remembered between visits — every load starts with a
// clean gate. removeItem also scrubs what older builds persisted.
localStorage.removeItem("oh-portal-name");

// A dropped file must never navigate the tab away from the room — the
// pane-level handler consumes real image drops.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// Leaving gracefully (docs/member-liveness-study.md layer A): pagehide is
// the one unload event every browser — including iOS Safari — emits
// reliably. A member tells its host; a HOST tells each member, so
// survivors re-seat onto a takeover in seconds instead of waiting out the
// 5-minute record lapse. Beacons survive unload; nothing else about the
// tab does. Deliberately NOT wired to visibilitychange — backgrounding a
// phone tab is "away", not "left".
window.addEventListener("pagehide", () => {
  if (portal.room) {
    if (portal.isHost) {
      for (const p of portal.members.keys()) {
        if (p !== portal.peerId) portal.hub.leaveOnce(portal.peerId, portal.pubB64, portal.sign, p, portal.roomHex);
      }
    } else if (portal.hostId) {
      portal.hub.leaveOnce(portal.peerId, portal.pubB64, portal.sign, portal.hostId, portal.roomHex);
    }
  }
  // Drop out of the site's public counter too, so "N online" is truthful
  // the moment a tab closes instead of riding out the 5-minute TTL.
  navigator.sendBeacon("/api/presence",
    new Blob([JSON.stringify({ token: portal.presenceToken, leave: true })], { type: "application/json" }));
  portal.room = null; // the loops are dying with the page; nothing may re-seat
});

// Console hook for e2e/debugging (same spirit as __ohPortal).
(window as any).__ohImg = { pickImage, pickFile, fileToImagePayload, parseChatBody, mailFits, triggerFileDownload, validEmoji, pending: () => pendingImg, pendingFile: () => pendingFile };
// Liveness e2e hook: frame kinds (to forge/craft sealed frames) and the
// liveness tunables already sit on __ohPortal as fields.
(window as any).__ohLive = { KIND };

render();
portal.prefetch();
