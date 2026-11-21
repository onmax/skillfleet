// Draws the brand from one mark, a regatta: three sails on one waterline, the tallest in blue. A fleet is ships, and
// the lead sail is the source the others follow. It makes the logo, the favicons, the icons a phone and a shared link
// show, and the README banner in a light and a dark version, in .github/assets.
// Usage: node --no-warnings .github/scripts/brand.ts (needs sharp)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import { agents } from "./agents.ts";

// Picked in oklch and written as hex, because librsvg, which renders the PNGs, doesn't read oklch().
// Contrast is WCAG 2 against each theme's background.
const light = {
  bg: "#f9f5ec", // oklch(0.97 0.012 85)
  panel: "#ede7dc", // oklch(0.93 0.016 85)
  fg: "#111b28", // oklch(0.22 0.03 255), 15.9:1
  muted: "#424e5e", // oklch(0.42 0.03 255), 7.8:1
  faint: "#5f6a77", // oklch(0.52 0.025 255), 5.1:1
  lead: "#2763d7", // oklch(0.53 0.19 262), 5:1, the source sail
};
const dark = {
  bg: "#0c141f", // oklch(0.19 0.025 255)
  panel: "#141e2a", // oklch(0.23 0.028 255)
  fg: "#f9f5ec", // oklch(0.97 0.012 85), 17:1
  muted: "#b5bfcb", // oklch(0.8 0.02 255), 9.9:1
  faint: "#848d98", // oklch(0.64 0.02 255), 5.5:1
  lead: "#6a9cfb", // oklch(0.7 0.15 262), 6.8:1, lighter so it holds on the dark ground
};
type Theme = typeof light;

// The mark, in a 128 box. Fills are classes, so an SVG favicon can switch them with prefers-color-scheme.
const sail = (x: number, h: number, w: number, cls: string, base = 98) =>
  `<path class="${cls}" d="M${x} ${base} V${base - h} Q${x + w * 0.95} ${base - h * 0.45} ${x + w} ${base} Z" stroke-width="5" stroke-linejoin="round"/>`;
const mark = `${sail(18, 74, 34, "lead")}
${sail(56, 58, 28, "fg")}
${sail(88, 42, 22, "fg")}
<rect class="hull" x="14" y="104" width="100" height="9" rx="4.5"/>`;

const style = (t: Theme) =>
  `.bg{fill:${t.bg}}.fg{fill:${t.fg};stroke:${t.fg}}.lead{fill:${t.lead};stroke:${t.lead}}.hull{fill:${t.fg}}`;

// The logo and favicons: the mark on a rounded tile, light by default and dark where the reader prefers it.
const logo = (size: number, rx = 28) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128" role="img" aria-labelledby="t">
<title id="t">fleetrc</title>
<style>${style(light)}@media (prefers-color-scheme:dark){${style(dark)}}</style>
<rect class="bg" width="128" height="128" rx="${rx}"/>
${mark}
</svg>
`;
// A phone and a shared link round the corners themselves.
const tile = (size: number) => logo(size, 0);

const font = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// On the right, the fleet: a row per machine, a column per agent, and a sail where its skills are current. One cell is
// held, because fleetrc keeps a skill you edited instead of overwriting it.
const machines = [
  ["laptop", "macOS"],
  ["desktop", "Windows"],
  ["homelab", "Linux"],
];
const cellSail = (x: number, y: number) =>
  `M${x} ${y + 11} V${y - 13} Q${x + 17} ${y} ${x + 18} ${y + 11} Z`;
const fleet = (t: Theme) => {
  const cx = (i: number) => 902 + i * 60;
  const cy = (r: number) => 160 + r * 72;
  const logos = agents
    .map(
      (agent, i) =>
        `<svg x="${cx(i) - 13}" y="70" width="26" height="26" viewBox="0 0 24 24" fill="${t.fg}" fill-rule="evenodd" role="img" aria-label="${agent.name}">${agent.svg}</svg>`,
    )
    .join("\n");
  const rows = machines
    .map(
      ([name, system], r) =>
        `<text x="852" y="${cy(r) - 2}" text-anchor="end" font-family="${mono}" font-size="17" fill="${t.fg}">${name}</text>
<text x="852" y="${cy(r) + 17}" text-anchor="end" font-family="${mono}" font-size="13" fill="${t.faint}">${system}</text>
<rect x="872" y="${cy(r) + 18}" width="360" height="1" fill="${t.faint}" opacity=".25"/>`,
    )
    .join("\n");
  const cells = machines
    .flatMap((_, r) =>
      agents.map((_, i) =>
        r === 2 && i === 3
          ? `<path d="${cellSail(cx(i) - 8, cy(r))}" fill="none" stroke="${t.faint}" stroke-width="2" stroke-linejoin="round"/>`
          : `<path d="${cellSail(cx(i) - 8, cy(r))}" fill="${t.lead}" stroke="${t.lead}" stroke-width="2" stroke-linejoin="round"/>`,
      ),
    )
    .join("\n");
  const legend = `<g font-family="${mono}" font-size="13" fill="${t.faint}">
<path d="M872 371 V355 Q884 363 884 371 Z" fill="${t.lead}"/><text x="892" y="370">synced</text>
<path d="M962 371 V355 Q974 363 974 371 Z" fill="none" stroke="${t.faint}" stroke-width="1.5"/><text x="982" y="370">held: your edit kept</text>
</g>`;
  return `${logos}\n${rows}\n${cells}\n${legend}`;
};

// The mark and name on the left, a line and the two commands under them; the fleet on the right.
const banner = (
  t: Theme,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="400" viewBox="0 0 1280 400" role="img" aria-labelledby="t">
<title id="t">fleetrc: the same skills on every agent and every machine, synced when an agent session starts</title>
<style>${style(t)}</style>
<clipPath id="frame"><rect width="1280" height="400" rx="24"/></clipPath>
<g clip-path="url(#frame)">
<rect width="1280" height="400" fill="${t.bg}"/>
<rect x="760" y="0" width="520" height="400" fill="${t.panel}"/>
${fleet(t)}
<g transform="translate(76 70) scale(.62)">
${mark}
</g>
<text x="172" y="146" fill="${t.fg}" font-family="${font}" font-size="88" font-weight="700" letter-spacing="-3">fleetrc</text>
<text x="80" y="200" fill="${t.muted}" font-family="${font}" font-size="27">The same skills on every agent and every machine.</text>
<g font-family="${mono}" font-size="22">
<text x="80" y="286" fill="${t.faint}">$ <tspan fill="${t.fg}">npx fleetrc init</tspan> <tspan fill="${t.lead}">onmax/skills</tspan></text>
<text x="80" y="326" fill="${t.faint}">$ <tspan fill="${t.fg}">fleetrc fleet sync</tspan>  # every machine</text>
</g>
</g>
</svg>
`;

const write = (file: string, content: string | Buffer) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(file);
};
const png = (source: string, size: number) =>
  sharp(Buffer.from(source), { density: 300 }).resize(size, size).png().toBuffer();

// An .ico is a directory of images, and each may be a whole PNG.
const ico = (images: [size: number, png: Buffer][]) => {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(([size, data], i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size, at);
    head.writeUInt8(size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(([, data]) => data)]);
};

write(".github/assets/logo.svg", logo(64));
write(".github/assets/favicon.svg", logo(32));
write(".github/assets/favicon-32.png", await png(logo(32), 32));
write(
  ".github/assets/favicon.ico",
  ico(
    await Promise.all(
      [16, 32, 48].map(async (size) => [size, await png(logo(size), size)] as const),
    ),
  ),
);
write(".github/assets/apple-touch-icon.png", await png(tile(180), 180));
write(".github/assets/logo-512.png", await png(tile(512), 512));
for (const [name, theme] of [
  ["light", light],
  ["dark", dark],
] as const) {
  const svg = banner(theme);
  write(`.github/assets/banner-${name}.svg`, svg);
  write(
    `.github/assets/banner-${name}.png`,
    await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer(),
  );
}
