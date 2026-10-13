import { unzipSync, zipSync, strToU8 } from "fflate";
import { getExtension } from "@/lib/utils";
import { safeText } from "./pdf-edit";

/**
 * Text documents: TXT, Markdown, RTF and DOCX in; PDF, DOCX, TXT and Markdown out.
 *
 * Everything passes through a flat list of blocks (headings, paragraphs, list
 * items). That keeps the structure a reader cares about and drops what a
 * browser cannot lay out faithfully anyway: fonts, tables, images, columns.
 */

export interface DocBlock {
  style: "h1" | "h2" | "h3" | "p" | "li" | "break";
  text: string;
}

const stripInline = (text: string) => text.replace(/(\*\*|__|`)/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

function markdownToBlocks(source: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ style: "p", text: stripInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of source.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      blocks.push({ style: (["h1", "h2", "h3"] as const)[Math.min(heading[1].length, 3) - 1], text: stripInline(heading[2]) });
    } else if (item) {
      flush();
      blocks.push({ style: "li", text: stripInline(item[2]) });
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

const textToBlocks = (source: string): DocBlock[] =>
  source.replace(/\r/g, "").split("\n").map((text) => ({ style: "p" as const, text }));

/** Control words that open a group holding no body text. */
const RTF_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "object", "themedata", "datastore", "generator",
]);

function rtfToText(rtf: string): string {
  const cp1252 = new TextDecoder("windows-1252");
  const stack: boolean[] = [];
  let skip = false;
  let out = "";
  for (let i = 0; i < rtf.length; ) {
    const ch = rtf[i];
    if (ch === "{") { stack.push(skip); i++; continue; }
    if (ch === "}") { skip = stack.pop() ?? false; i++; continue; }
    if (ch === "\r" || ch === "\n") { i++; continue; }
    if (ch !== "\\") { if (!skip) out += ch; i++; continue; }

    const next = rtf[i + 1];
    if (next === "\\" || next === "{" || next === "}") { if (!skip) out += next; i += 2; continue; }
    if (next === "*") { skip = true; i += 2; continue; }
    if (next === "'") {
      if (!skip) out += cp1252.decode(new Uint8Array([parseInt(rtf.slice(i + 2, i + 4), 16) || 63]));
      i += 4;
      continue;
    }
    const word = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 48));
    if (!word) { i += 2; continue; }
    i += 1 + word[0].length;
    if (RTF_DESTINATIONS.has(word[1])) skip = true;
    else if (!skip) {
      if (word[1] === "par" || word[1] === "line") out += "\n";
      else if (word[1] === "tab") out += "\t";
      else if (word[1] === "u" && word[2]) {
        const code = Number(word[2]);
        out += String.fromCharCode(code < 0 ? code + 65536 : code);
        // One fallback character follows for readers without Unicode support.
        if (rtf.startsWith("\\'", i)) i += 4;
        else if (rtf[i] && !"\\{}".includes(rtf[i])) i++;
      }
    }
  }
  return out;
}

function docxToBlocks(bytes: Uint8Array): DocBlock[] {
  const xml = unzipSync(bytes, { filter: (entry) => entry.name === "word/document.xml" })["word/document.xml"];
  if (!xml) throw new Error("This is not a Word document (word/document.xml is missing).");
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), "application/xml");
  const blocks: DocBlock[] = [];

  for (const paragraph of Array.from(doc.getElementsByTagName("w:p"))) {
    let text = "";
    const walk = (node: Element) => {
      for (const child of Array.from(node.children)) {
        if (child.tagName === "w:t") text += child.textContent ?? "";
        else if (child.tagName === "w:tab") text += "\t";
        else if (child.tagName === "w:br" || child.tagName === "w:cr") text += "\n";
        else if (child.tagName !== "w:pPr") walk(child);
      }
    };
    walk(paragraph);

    // Headings are named by style in Word's own files and by outline level in
    // files written without a style sheet (including the ones this module writes).
    const styleName = paragraph.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val") ?? "";
    const outline = paragraph.getElementsByTagName("w:outlineLvl")[0]?.getAttribute("w:val");
    const level = /^title$/i.test(styleName) ? 1
      : Number(/heading\s*(\d)/i.exec(styleName)?.[1] ?? 0) || (outline != null ? Number(outline) + 1 : 0);
    const typedBullet = /^[•·\-*]\s+/.exec(text);
    const listed = paragraph.getElementsByTagName("w:numPr").length > 0 || !!typedBullet;
    blocks.push({
      style: level ? (["h1", "h2", "h3"] as const)[Math.min(level, 3) - 1] : listed ? "li" : "p",
      text: typedBullet ? text.slice(typedBullet[0].length) : text,
    });
  }
  return blocks;
}

/** Reads any supported text document into blocks. */
export async function readDocument(file: File): Promise<DocBlock[]> {
  switch (getExtension(file.name)) {
    case "docx": return docxToBlocks(new Uint8Array(await file.arrayBuffer()));
    case "md": return markdownToBlocks(await file.text());
    case "rtf": return textToBlocks(rtfToText(await file.text()).trim());
    default: return textToBlocks(await file.text());
  }
}

export function blocksToText(blocks: DocBlock[], markdown: boolean): Blob {
  const lines = blocks.map((block) => {
    if (block.style === "break") return markdown ? "\n---\n" : "";
    if (!markdown) return block.style === "li" ? `- ${block.text}` : block.text;
    if (block.style === "li") return `- ${block.text}`;
    if (block.style === "p") return `${block.text}\n`;
    return `${"#".repeat(Number(block.style[1]))} ${block.text}\n`;
  });
  return new Blob([lines.join("\n")], { type: markdown ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" });
}

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Half-point sizes Word uses for each block style. */
const DOCX_SIZE = { h1: 40, h2: 32, h3: 26 } as const;

export function blocksToDocx(blocks: DocBlock[]): Blob {
  const run = (text: string, props = "") =>
    text.split("\n").map((part, i) =>
      `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlEscape(part)}</w:t></w:r>`
    ).join("");

  const body = blocks.map((block) => {
    if (block.style === "break") return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    if (block.style === "p") return `<w:p>${run(block.text)}</w:p>`;
    if (block.style === "li") return `<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${run(`•\t${block.text}`)}</w:p>`;
    const size = DOCX_SIZE[block.style];
    // The outline level makes these real headings in Word's navigation pane.
    return `<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${Number(block.style[1]) - 1}"/></w:pPr>${run(block.text, `<w:b/><w:sz w:val="${size}"/>`)}</w:p>`;
  }).join("");

  const ns = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
  };
  const entries: Record<string, Uint8Array> = {};
  for (const [name, xml] of Object.entries(files)) entries[name] = strToU8(xml);
  return new Blob([zipSync(entries) as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

const PAGE = { width: 595.28, height: 841.89, margin: 56 }; // A4
const PDF_SIZE = { h1: 22, h2: 17, h3: 14, p: 11, li: 11 } as const;

/** Lays blocks out on A4 pages with word wrapping. */
export async function blocksToPdf(blocks: DocBlock[]): Promise<Blob> {
  const lib = await import("@cantoo/pdf-lib");
  const doc = await lib.PDFDocument.create();
  const regular = await doc.embedFont(lib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(lib.StandardFonts.HelveticaBold);
  const usable = PAGE.width - PAGE.margin * 2;

  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - PAGE.margin;
  };

  for (const block of blocks) {
    if (block.style === "break") { newPage(); continue; }
    const size = PDF_SIZE[block.style];
    const font = block.style === "p" || block.style === "li" ? regular : bold;
    const indent = block.style === "li" ? 16 : 0;
    const leading = size * 1.4;
    if (font === bold) y -= size * 0.6;

    for (const [n, hard] of safeText(font, block.text).split("\n").entries()) {
      // Greedy wrap; a single word wider than the line is cut by character.
      const lines: string[] = [];
      let line = "";
      for (const word of hard.split(" ")) {
        let piece = word;
        while (font.widthOfTextAtSize(piece, size) > usable - indent) {
          let cut = piece.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(piece.slice(0, cut), size) > usable - indent) cut--;
          if (line) { lines.push(line); line = ""; }
          lines.push(piece.slice(0, cut));
          piece = piece.slice(cut);
        }
        const candidate = line ? `${line} ${piece}` : piece;
        if (line && font.widthOfTextAtSize(candidate, size) > usable - indent) {
          lines.push(line);
          line = piece;
        } else line = candidate;
      }
      lines.push(line);

      lines.forEach((text, i) => {
        if (y - leading < PAGE.margin) newPage();
        y -= leading;
        if (block.style === "li" && n === 0 && i === 0) page.drawText("•", { x: PAGE.margin + 4, y, size, font });
        if (text) page.drawText(text, { x: PAGE.margin + indent, y, size, font });
      });
    }
    y -= size * 0.45;
  }

  return new Blob([(await doc.save()) as BlobPart], { type: "application/pdf" });
}
