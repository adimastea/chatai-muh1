require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const mammoth = require('mammoth');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const PROVIDER = process.env.PROVIDER || 'gemini';

const SYSTEM_PROMPT = `Kamu adalah asisten virtual SMK Muhammadiyah 1 Kota Sukabumi.
Jawab dengan ramah, singkat, dan dalam Bahasa Indonesia.
Bantu pertanyaan seputar jurusan, akreditasi, fasilitas, alamat, dan pendaftaran sekolah.
Jika kamu tidak yakin atau tidak punya datanya, jujur katakan tidak tahu dan sarankan
menghubungi pihak sekolah. Jangan mengarang informasi.`;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let ai = null;
if (PROVIDER !== 'mock') {
  if (!process.env.GEMINI_API_KEY) {
    console.error('PERINGATAN: GEMINI_API_KEY belum diisi di file .env');
  } else {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
}

// Kirim ke Gemini, kembalikan teks jawaban
async function askGemini(parts, history = []) {
  const contents = [...history, { role: 'user', parts }];
  const result = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: { systemInstruction: SYSTEM_PROMPT },
  });
  return result.text || 'Maaf, saya belum bisa menjawab itu.';
}

// Ambil teks pertanyaan dari body (mendukung beberapa nama kolom)
function pickText(b) {
  return (
    b.pertanyaan || b.pesan || b.message || b.prompt ||
    b.teks || b.text || b.tanya || b.question || ''
  );
}

// Ubah riwayat dari frontend ke format Gemini
function pickHistory(b) {
  const raw = b.riwayat || b.history || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((h) => {
      const text = h && (h.text || h.content || h.teks || h.pesan);
      if (!text) return null;
      const isUser = h.role === 'user' || h.role === 'me';
      return { role: isUser ? 'user' : 'model', parts: [{ text: String(text) }] };
    })
    .filter(Boolean);
}

// Baca multipart/form-data tanpa library tambahan (Node 18+)
async function readForm(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return new Response(buf, {
    headers: { 'content-type': req.headers['content-type'] || '' },
  }).formData();
}

// ===== Teks =====
app.post('/tanya-ai', async (req, res) => {
  try {
    const body = req.body || {};
    const pertanyaan = String(pickText(body)).trim();
    if (!pertanyaan) return res.status(400).json({ error: 'Pertanyaan kosong.' });

    if (PROVIDER === 'mock') {
      return res.json({ jawaban: `[MOCK] Kamu bertanya: "${pertanyaan}"` });
    }
    if (!ai) return res.status(500).json({ error: 'API key belum diatur di .env' });

    const jawaban = await askGemini([{ text: pertanyaan }], pickHistory(body));
    res.json({ jawaban });
  } catch (err) {
    console.error('=== ERROR /tanya-ai ===');
    console.error(err && err.message ? err.message : err);
    res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  }
});

// ===== Lampiran (gambar / dokumen) =====
async function handleUpload(req, res, field) {
  try {
    const form = await readForm(req);
    const file = form.get(field);
    const instruksi =
      String(form.get('instruksi') || '').trim() ||
      (field === 'gambar' ? 'Jelaskan gambar ini.' : 'Ringkas dokumen ini.');

    if (!file || typeof file === 'string') {
      return res.status(400).json({ error: 'File tidak ditemukan.' });
    }

    if (PROVIDER === 'mock') {
      return res.json({ analisis: `[MOCK] File "${file.name}" diterima.`, jawaban: `[MOCK] File "${file.name}" diterima.` });
    }
    if (!ai) return res.status(500).json({ error: 'API key belum diatur di .env' });

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'application/octet-stream';
    const name = file.name || 'lampiran';
    const parts = [];

    if (mimeType.includes('wordprocessingml') || /\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer });
      parts.push({ text: `Isi dokumen "${name}":\n${r.value}` });
    } else if (mimeType.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) {
      parts.push({ text: `Isi file "${name}":\n${buffer.toString('utf8')}` });
    } else {
      // gambar dan PDF dikirim langsung ke Gemini
      parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
    }
    parts.push({ text: instruksi });

    const analisis = await askGemini(parts);
    res.json({ analisis, jawaban: analisis });
  } catch (err) {
    console.error(`=== ERROR upload (${field}) ===`);
    console.error(err && err.message ? err.message : err);
    res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  }
}

app.post('/analisis-gambar', (req, res) => handleUpload(req, res, 'gambar'));
app.post('/analisis-dokumen', (req, res) => handleUpload(req, res, 'dokumen'));

app.listen(PORT, () => {
  console.log(`Web berjalan di http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER} | Model: ${MODEL}`);
});