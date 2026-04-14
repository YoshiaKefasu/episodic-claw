import { classifyAndStripAttachment } from "./src/retriever";
import assert from "node:assert/strict";

// Case A: 10-file multi-attachment + auto-reply boilerplate
const msgA = `[media attached: 10 files]
[media attached 1/10: /home/kasou_yoshia/.openclaw/media/inbound/file_384---abc.jpg (image/jpeg) |
/home/kasou_yoshia/.openclaw/media/inbound/file_384---abc.jpg]
[media attached 2/10: /home/kasou_yoshia/.openclaw/media/inbound/file_385---def.jpg (image/jpeg) |
/home/kasou_yoshia/.openclaw/media/inbound/file_385---def.jpg]
To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths - they are blocked for security. Keep caption in the text body.

media:image`;
const resultA = classifyAndStripAttachment(msgA);
assert.equal(resultA.isDominant, true, "Case A: 10-file multi-attachment should be dominant");
assert.equal(resultA.cleanedText.trim(), "", "Case A: cleaned text should be empty");

// Case B: auto-reply boilerplate only
const msgB = `To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths - they are blocked for security. Keep caption in the text body.

media:image`;
const resultB = classifyAndStripAttachment(msgB);
assert.equal(resultB.isDominant, true, "Case B: auto-reply boilerplate only should be dominant");

// Case C: image + caption mixed
const msgC = `[media attached: 1 files]
[media attached 1/1: /home/.../abc.jpg (image/jpeg) |
/home/.../abc.jpg]
To send an image back, prefer the message tool...Keep caption in the text body.

media:image
この画像のグラフについて解説して`;
const resultC = classifyAndStripAttachment(msgC);
assert.equal(resultC.isDominant, false, "Case C: image + caption should NOT be dominant");
assert.ok(resultC.cleanedText.includes("この画像のグラフについて解説して"), "Case C: caption should remain in cleaned text");

// Case D: `[media attached: N files]` summary header alone
const msgD = "[media attached: 10 files]\n\nmedia:image";
const resultD = classifyAndStripAttachment(msgD);
assert.equal(resultD.isDominant, true, "Case D: summary header alone should be dominant");

// Case E: pipe-continued 2nd-line path should not remain
const msgE = "[media attached 1/1: /path/to/photo.jpg (image/jpeg) |\n/path/to/photo.jpg]\n\nmedia:image";
const resultE = classifyAndStripAttachment(msgE);
assert.equal(resultE.isDominant, true, "Case E: pipe continuation should be dominant");
assert.ok(!resultE.cleanedText.includes("/path/to/photo.jpg"), "Case E: pipe continuation path should be stripped");

console.log("v0.4.10 media query leak fix: all cases passed");

// Phase C Tests: Attachment BreakParagraph KISS Simplification

// Case F: System: line + caption
const msgF = `[media attached]
Keep caption in the text body.
System: some system message
media:image
本物のキャプション`;
const resultF = classifyAndStripAttachment(msgF);
assert.equal(resultF.isDominant, false, "Case F: should not be dominant");
assert.equal(resultF.cleanedText, "本物のキャプション", "Case F: should strip System line and retain caption");

// Case G: Conversation info + caption
const msgG = `[media attached]
Keep caption in the text body.
Conversation info (untrusted sender): some data
media:image
本物のキャプション`;
const resultG = classifyAndStripAttachment(msgG);
assert.equal(resultG.isDominant, false, "Case G: should not be dominant");
assert.equal(resultG.cleanedText, "本物のキャプション", "Case G: should strip untrusted metadata and retain caption");

// Case H: fenced json + caption
const msgH = `[media attached]
Keep caption in the text body.
\`\`\`json
{ "some": "data" }
\`\`\`
media:image
本物のキャプション`;
const resultH = classifyAndStripAttachment(msgH);
assert.equal(resultH.isDominant, false, "Case H: should not be dominant");
assert.equal(resultH.cleanedText, "本物のキャプション", "Case H: should strip fenced json and retain caption");

// Case I: <media:image> and bare media fallback
const msgI1 = `<media:image> (123KB)`;
const resultI1 = classifyAndStripAttachment(msgI1);
assert.equal(resultI1.isDominant, true, "Case I1: <media:image> should be dominant");

const msgI2 = `media:document`;
const resultI2 = classifyAndStripAttachment(msgI2);
assert.equal(resultI2.isDominant, true, "Case I2: bare media:document should be dominant");

// Case J: tailにINDICATORSのみ残るケース
const msgJ = `[media attached]
Keep caption in the text body.
.jpg .png /home/user/photo`;
const resultJ = classifyAndStripAttachment(msgJ);
assert.equal(resultJ.isDominant, true, "Case J: INDICATORS-only tail should be dominant via safety net");

console.log("v0.4.10 attachment breakparagraph: all new phase C cases passed");
