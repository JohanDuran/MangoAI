// MCP server (stdio, no dependencies) exposing one tool: generate_image.
// The runner starts it for a Claude call and passes MANGOAI_PROJECT_DIR, MANGOAI_RUNNER_URL
// and the env keys declared in skill.json (OPENAI_API_KEY). OPENAI_BASE_URL is optional.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const projectDir = process.env.MANGOAI_PROJECT_DIR;
const runnerUrl = process.env.MANGOAI_RUNNER_URL;
const apiKey = process.env.OPENAI_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

const TOOL = {
  name: 'generate_image',
  description:
    'Generate one image from a text prompt and return a URL to use as an <img> src or an ImagePopup src. Costs money and takes 10-60 seconds, so call it at most once or twice per marker and only when an image clearly improves the animation.',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'What the image should show. Be concrete.' } },
    required: ['prompt'],
  },
};

async function generateImage(prompt) {
  if (!projectDir || !runnerUrl) throw new Error('MANGOAI_PROJECT_DIR / MANGOAI_RUNNER_URL are not set');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
  });
  if (!response.ok) throw new Error(`Image generation failed: ${response.status} ${await response.text()}`);
  const b64 = (await response.json()).data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data returned');

  const assetsDir = path.join(projectDir, '02_assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const file = `img_${Date.now()}.png`;
  fs.writeFileSync(path.join(assetsDir, file), Buffer.from(b64, 'base64'));

  const manifestFile = path.join(assetsDir, 'asset_manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) : [];
  manifest.push({ file, prompt, createdAt: new Date().toISOString() });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  return `${runnerUrl}/projects/${path.basename(projectDir)}/assets/${file}`;
}

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

async function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'image-generation', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } });
  } else if (msg.method === 'tools/call') {
    try {
      if (msg.params.name !== TOOL.name) throw new Error(`Unknown tool ${msg.params.name}`);
      const prompt = String(msg.params.arguments?.prompt ?? '').trim();
      if (!prompt) throw new Error('prompt is required');
      const url = await generateImage(prompt);
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Image generated. Use this exact URL as the src: ${url}` }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] } });
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  handle(JSON.parse(line));
});
