// Tiny, safe markdown renderer. All text is HTML-escaped first; only a small
// set of markdown constructs are turned back into tags. Links allow http(s) only.
(function (global) {
  function esc(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inline(s) {
    // s is already escaped
    const codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return "<code>" + codes[+i] + "</code>";
    });
    return s;
  }

  function render(src) {
    const lines = esc(String(src || "").replace(/\r\n?/g, "\n")).split("\n");
    const out = [];
    let para = [];
    let list = null; // { type: 'ul'|'ol', items: [] }

    function flushPara() {
      if (para.length) {
        out.push("<p>" + inline(para.join("<br>")) + "</p>");
        para = [];
      }
    }
    function flushList() {
      if (list) {
        out.push("<" + list.type + ">" + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + "</" + list.type + ">");
        list = null;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // fenced code block
      if (/^\s*```/.test(line)) {
        flushPara();
        flushList();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }

      let m;
      if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
        flushPara();
        flushList();
        const level = Math.min(6, m[1].length + 2); // h3..h6 inside cards
        out.push("<h" + Math.min(level, 6) + ">" + inline(m[2]) + "</h" + Math.min(level, 6) + ">");
        continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        flushPara();
        flushList();
        out.push("<hr>");
        continue;
      }
      if ((m = line.match(/^\s*&gt;\s?(.*)$/))) {
        flushPara();
        flushList();
        out.push("<blockquote>" + inline(m[1]) + "</blockquote>");
        continue;
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== "ul") {
          flushList();
          list = { type: "ul", items: [] };
        }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== "ol") {
          flushList();
          list = { type: "ol", items: [] };
        }
        list.items.push(m[1]);
        continue;
      }
      // continuation of a list item (indented line)
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += " " + line.trim();
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return out.join("\n");
  }

  global.renderMarkdown = render;
  if (typeof module !== "undefined" && module.exports) module.exports = { renderMarkdown: render };
})(typeof window !== "undefined" ? window : globalThis);
