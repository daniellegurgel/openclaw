const text = "[[template: prospeccao_fellipe_v2 | Bom dia | Paulo]]";
const match = text.match(/\[\[template:\s*([\s\S]*?)\]\]/i);
if (!match) { console.log("NO MATCH"); process.exit(1); }
const inner = match[1];
const parts = inner.split("|").map(s => s.trim()).filter(s => s.length > 0);
const templateName = parts[0];
const variables = parts.slice(1).filter(v => v.length > 0);
const cleanText = text.replace(/\[\[template:[\s\S]*?\]\]/gi, "").trim();
const result = {
  text: cleanText || undefined,
  channelData: {
    "api-meta": {
      template: {
        name: templateName,
        language: "pt_BR",
        variables: variables.length ? variables : undefined,
      },
    },
  },
};
console.log(JSON.stringify(result, null, 2));
