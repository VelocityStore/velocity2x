const express = require("express");
const path = require("path");
const session = require("express-session");
const fetch = require("node-fetch");
const fs = require("fs");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/discord/callback`;
const LINKS_FILE = path.join(__dirname, "links.json");
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";
const STEAM_API_KEY = process.env.STEAM_API_KEY;

function loadLinks() {
  try {
    const data = fs.readFileSync(LINKS_FILE, "utf8");
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveLinks(links) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

function saveLinkIfComplete(sessionData) {
  if (!sessionData.user || !sessionData.steam) return;
  const links = loadLinks();
  const entry = {
    discordId: sessionData.user.id,
    discordUsername:
      sessionData.user.username + "#" + sessionData.user.discriminator,
    steamId: sessionData.steam.steamId
  };
  const index = links.findIndex(
    l => l.discordId === entry.discordId || l.steamId === entry.steamId
  );
  if (index >= 0) {
    links[index] = entry;
  } else {
    links.push(entry);
  }
  saveLinks(links);
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false
  })
);

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "home.html"));
});

app.get("/auth/discord", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res
      .status(500)
      .send("Discord OAuth is not configured. Set environment variables first.");
  }

  if (req.query.redirect) {
    req.session.afterDiscordRedirect = req.query.redirect;
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "identify"
  });

  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("Missing code parameter.");
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      return res.status(500).send("Failed to exchange code: " + text);
    }

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });

    if (!userResponse.ok) {
      const text = await userResponse.text();
      return res.status(500).send("Failed to fetch user: " + text);
    }

    const user = await userResponse.json();
    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar
    };
    saveLinkIfComplete(req.session);
    const redirectPath = req.session.afterDiscordRedirect || "/home.html";
    delete req.session.afterDiscordRedirect;
    res.redirect(redirectPath);
  } catch (err) {
    res.status(500).send("Unexpected error: " + err.message);
  }
});

app.get("/auth/steam", (req, res) => {
  const returnTo = `${BASE_URL}/auth/steam/callback`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": BASE_URL,
    "openid.identity":
      "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id":
      "http://specs.openid.net/auth/2.0/identifier_select"
  });
  res.redirect(`${STEAM_OPENID_URL}?${params.toString()}`);
});

app.get("/auth/steam/callback", async (req, res) => {
  const query = req.query;
  if (!query["openid.claimed_id"]) {
    return res.status(400).send("Missing claimed_id.");
  }

  const params = new URLSearchParams();
  Object.keys(query).forEach(key => {
    if (key.startsWith("openid.")) {
      if (key === "openid.mode") {
        params.append(key, "check_authentication");
      } else {
        params.append(key, query[key]);
      }
    }
  });

  try {
    const verifyResponse = await fetch(STEAM_OPENID_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const text = await verifyResponse.text();
    if (!text.includes("is_valid:true")) {
      return res.status(400).send("Invalid Steam login.");
    }

    const claimedId = query["openid.claimed_id"];
    const parts = claimedId.split("/");
    const steamId = parts[parts.length - 1];
    let personaName = null;
    if (STEAM_API_KEY) {
      const url =
        "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?" +
        new URLSearchParams({
          key: STEAM_API_KEY,
          steamids: steamId
        }).toString();
      const profileResponse = await fetch(url);
      if (profileResponse.ok) {
        const profileData = await profileResponse.json();
        const players = profileData.response && profileData.response.players;
        if (Array.isArray(players) && players[0] && players[0].personaname) {
          personaName = players[0].personaname;
        }
      }
    }
    req.session.steam = { steamId, personaName };
    saveLinkIfComplete(req.session);
    res.redirect("/link.html");
  } catch (err) {
    res.status(500).send("Steam auth failed: " + err.message);
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/home.html");
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user: req.session.user });
});

app.get("/api/link-status", (req, res) => {
  res.json({
    steam: req.session.steam || null,
    discord: req.session.user || null
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
