// post-poll.js
// Fetches 3 trending movies from TMDB, builds a single collage image
// (poster + title + CTA for each movie: Follow / Share / Like), and
// posts it as a photo to the Best Clips Facebook Page.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const {
  TMDB_API_KEY,
  FB_PAGE_ID,
  FB_PAGE_TOKEN,
} = process.env;

const STATE_FILE = path.join(__dirname, "posted.json");
const TMP_DIR = "/tmp/bestclips";

const CTA_LABELS = ["FOLLOW", "SHARE", "LIKE"];
const CTA_COLORS = ["#1877F2", "#42B72A", "#F02849"]; // FB blue, green, red-ish

function requireEnv() {
  const missing = ["TMDB_API_KEY", "FB_PAGE_ID", "FB_PAGE_TOKEN"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    throw new Error("Missing required env vars: " + missing.join(", "));
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { posted: [] };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { posted: [] };
  }
}

function saveState(state) {
  state.posted = state.posted.slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchTrendingMovies() {
  const url = `https://api.themoviedb.org/3/trending/movie/day?api_key=${TMDB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB fetch failed: ${res.status}`);
  const data = await res.json();
  return (data.results || []).filter((m) => m.poster_path);
}

function pickThreeMovies(candidates, alreadyPosted) {
  // Prefer movies not posted before; if we run low, allow repeats.
  const fresh = candidates.filter((m) => !alreadyPosted.includes(m.id));
  const pool = fresh.length >= 3 ? fresh : candidates;
  // Take top 3 by popularity (TMDB trending is already sorted)
  return pool.slice(0, 3);
}

async function downloadPoster(posterPath, destPath) {
  const url = `https://image.tmdb.org/t/p/w500${posterPath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Poster download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapText(text, maxChars) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current += " " + word;
    }
  }
  if (current) lines.push(current.trim());
  return lines.slice(0, 2); // max 2 lines
}

async function buildCollageImage(movies, outputPath) {
  const CANVAS_W = 1080;
  const ROW_H = 460;
  const CANVAS_H = ROW_H * 3 + 220; // 3 rows + header space
  const POSTER_W = 320;
  const POSTER_H = 420;
  const PADDING = 40;

  // Header SVG
  const headerSvg = `
    <svg width="${CANVAS_W}" height="220">
      <rect width="100%" height="100%" fill="#0d0d0d"/>
      <text x="50%" y="90" font-family="Arial, sans-serif" font-size="58" font-weight="bold"
        fill="#ffffff" text-anchor="middle">Which is YOUR</text>
      <text x="50%" y="160" font-family="Arial, sans-serif" font-size="58" font-weight="bold"
        fill="#FFD700" text-anchor="middle">Favourite Movie?</text>
    </svg>`;

  const composites = [
    { input: Buffer.from(headerSvg), top: 0, left: 0 },
  ];

  for (let i = 0; i < movies.length; i++) {
    const movie = movies[i];
    const rowTop = 220 + i * ROW_H;
    const posterTop = rowTop + (ROW_H - POSTER_H) / 2;

    // Row background (alternating shade)
    const rowBgSvg = `
      <svg width="${CANVAS_W}" height="${ROW_H}">
        <rect width="100%" height="100%" fill="${i % 2 === 0 ? "#1a1a1a" : "#141414"}"/>
      </svg>`;
    composites.push({ input: Buffer.from(rowBgSvg), top: rowTop, left: 0 });

    // Poster image, resized
    const posterPath = path.join(TMP_DIR, `poster-${i}.jpg`);
    const resizedBuffer = await sharp(posterPath)
      .resize(POSTER_W, POSTER_H, { fit: "cover" })
      .toBuffer();
    composites.push({ input: resizedBuffer, top: posterTop, left: PADDING });

    // Text block: movie title + big CTA label
    const titleLines = wrapText(movie.title, 18);
    const textX = PADDING + POSTER_W + 40;
    const textSvg = `
      <svg width="${CANVAS_W - textX - PADDING}" height="${ROW_H}">
        ${titleLines
          .map(
            (line, li) =>
              `<text x="0" y="${140 + li * 60}" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="#ffffff">${escapeXml(
                line
              )}</text>`
          )
          .join("")}
        <rect x="0" y="${ROW_H - 130}" width="260" height="90" rx="20" fill="${CTA_COLORS[i]}"/>
        <text x="130" y="${ROW_H - 72}" font-family="Arial, sans-serif" font-size="42" font-weight="bold"
          fill="#ffffff" text-anchor="middle">${CTA_LABELS[i]}</text>
      </svg>`;
    composites.push({ input: Buffer.from(textSvg), top: rowTop, left: textX });
  }

  await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 3,
      background: "#0d0d0d",
    },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

async function postPhotoToFacebook(imagePath, caption) {
  const form = new FormData();
  form.append("caption", caption);
  form.append("access_token", FB_PAGE_TOKEN);
  form.append("source", new Blob([fs.readFileSync(imagePath)]), "collage.jpg");

  const res = await fetch(
    `https://graph.facebook.com/v20.0/${FB_PAGE_ID}/photos`,
    { method: "POST", body: form }
  );
  const data = await res.json();
  if (!data.id) {
    throw new Error("Facebook photo post failed: " + JSON.stringify(data));
  }
  return data.id;
}

async function main() {
  requireEnv();
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const state = loadState();
  const candidates = await fetchTrendingMovies();
  console.log(`Fetched ${candidates.length} trending movies.`);

  const movies = pickThreeMovies(candidates, state.posted);
  if (movies.length < 3) {
    console.log("Not enough movies with posters available. Skipping.");
    return;
  }
  console.log("Selected:", movies.map((m) => m.title).join(", "));

  for (let i = 0; i < movies.length; i++) {
    await downloadPoster(movies[i].poster_path, path.join(TMP_DIR, `poster-${i}.jpg`));
  }

  const outputPath = path.join(TMP_DIR, "collage.jpg");
  await buildCollageImage(movies, outputPath);
  console.log("Collage built:", outputPath);

  const caption = `Which is YOUR favourite? 🎬\n\n${movies
    .map((m, i) => `${CTA_LABELS[i]} for ${m.title}!`)
    .join("\n")}\n\n#Movies #Bollywood #Hollywood #MovieLovers #Trending`;

  const photoId = await postPhotoToFacebook(outputPath, caption);
  console.log("Posted! Facebook photo_id:", photoId);

  state.posted.push(...movies.map((m) => m.id));
  saveState(state);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
