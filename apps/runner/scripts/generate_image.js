#!/usr/bin/env node
// Usage: node generate_image.js "<prompt>" <output-path-relative-to-cwd>
// Requires OPENAI_API_KEY in the environment. Writes a PNG to the given path.
import fs from 'node:fs';
import path from 'node:path';

const [, , prompt, outputPath] = process.argv;

if (!prompt || !outputPath) {
  console.error('Usage: node generate_image.js "<prompt>" <output-path>');
  process.exit(1);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set.');
  process.exit(1);
}

const response = await fetch('https://api.openai.com/v1/images/generations', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-image-1',
    prompt,
    size: '1024x1024',
    n: 1,
  }),
});

if (!response.ok) {
  const text = await response.text();
  console.error(`OpenAI image generation failed: ${response.status} ${text}`);
  process.exit(1);
}

const data = await response.json();
const b64 = data.data?.[0]?.b64_json;
if (!b64) {
  console.error('No image data returned.');
  process.exit(1);
}

const resolved = path.resolve(outputPath);
fs.mkdirSync(path.dirname(resolved), { recursive: true });
fs.writeFileSync(resolved, Buffer.from(b64, 'base64'));
console.log(resolved);
