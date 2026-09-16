const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { TOTP } = require('otpauth');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  CONFIG — Values come from .env file
// ============================================================
const CONFIG = {
  apiKey: process.env.ANGEL_API_KEY?.trim(),
  clientId: process.env.ANGEL_CLIENT_ID?.trim(),
  password: process.env.ANGEL_PASSWORD?.trim(),
  totpSecret: process.env.ANGEL_TOTP_SECRET?.replace(/\s/g, '').trim(),
  publicIp: process.env.ANGEL_PUBLIC_IP?.trim() || '127.0.0.1',
};

const ANGEL_BASE = 'https://apiconnect.angelbroking.com';

// ============================================================
//  SESSION — JWT token store (in-memory)
// ============================================================
let SESSION = {
  jwtToken: null,
  refreshToken: null,
  loginTime: null,
};

let MASTER = [];

const NIFTY_WEIGHTS = {
  ADANIENT: 0.79, ADANIPORTS: 1.24, APOLLOHOSP: 0.82, ASIANPAINT: 1.15,
  AXISBANK: 3.56, 'BAJAJ-AUTO': 1.06, BAJAJFINSV: 0.90, BAJFINANCE: 2.20,
  BEL: 1.36, BHARTIARTL: 5.16, CIPLA: 0.73, COALINDIA: 0.96,
  DRREDDY: 0.73, EICHERMOT: 0.93, ETERNAL: 1.60, GRASIM: 1.11,
  HCLTECH: 1.10, HDFCBANK: 10.74, HDFCLIFE: 0.55, HINDALCO: 1.40,
  HINDUNILVR: 1.79, ICICIBANK: 8.88, INDIGO: 0.96, INFY: 3.68,
  ITC: 2.57, JIOFIN: 0.71, JSWSTEEL: 1.13, KOTAKBANK: 2.73,
  LT: 4.28, 'M&M': 2.53, MARUTI: 1.62, MAXHEALTH: 0.71,
  NESTLEIND: 0.96, NTPC: 1.57, ONGC: 0.93, POWERGRID: 1.22,
  RELIANCE: 8.04, SBILIFE: 0.73, SBIN: 3.92, SHRIRAMFIN: 1.17,
  SUNPHARMA: 1.79, TATACONSUM: 0.68, TATASTEEL: 1.54, TCS: 2.06,
  TECHM: 0.88, TITAN: 1.57, TMPV: 0.74, TRENT: 0.85,
  ULTRACEMCO: 1.21, WIPRO: 0.48,
};
let niftyWeightsRefreshDate = null;

const STRONG_WEIGHTED_MOVE = 0.50;
const MILD_WEIGHTED_MOVE = 0.10;
const STOCK_DIRECTION_HISTORY = new Map();
const STOCK_BUCKET_HISTORY = new Map();
const SUSTAINABILITY_BUCKET_COUNT = 5;
const SUSTAINABILITY_HISTORY_LIMIT = 10;
const MARKET_MINUTES_PER_DAY = 375;
let ACTIVE_SUSTAINABILITY_BUCKET = null;

let MARKET_PULSE = {
  date: null,
  opening: null,
  trigger: null,
};
const PULSE_FILE = path.join(__dirname, 'market-pulse.json');

try {
  if (fs.existsSync(PULSE_FILE)) {
    MARKET_PULSE = JSON.parse(fs.readFileSync(PULSE_FILE, 'utf8'));
    if (!Array.isArray(MARKET_PULSE.captures)) MARKET_PULSE.captures = [];
  }
} catch (error) {
  console.error('Market pulse restore failed:', error.message);
}

function saveMarketPulse() {
  try {
    fs.writeFileSync(PULSE_FILE, JSON.stringify(MARKET_PULSE, null, 2));
  } catch (error) {
    console.error('Market pulse save failed:', error.message);
  }
}

function indiaDateTime() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function resetMarketPulseIfNewDay() {
  const { date } = indiaDateTime();
  if (MARKET_PULSE.date !== date) {
    MARKET_PULSE = { date, opening: null, captures: [], anchor: null };
    saveMarketPulse();
  }
}

function captureMarketPulse(spot, options) {
  resetMarketPulseIfNewDay();
  const { time } = indiaDateTime();
  MARKET_PULSE.windowStatus = time < '09:15:00'
    ? 'WAITING FOR 09:15'
    : time <= '15:30:00'
      ? 'MONITORING UNTIL 15:30'
      : 'MARKET CLOSED';

  if (!MARKET_PULSE.opening && time >= '09:15:00' && time <= '15:30:00') {
    MARKET_PULSE.opening = {
      time,
      spot,
      options: options.map(option => ({
        label: option.label,
        strike: option.strike,
        type: option.type,
        price: option.price,
        oi: option.oi,
        bidQty: option.bidQty,
        askQty: option.askQty,
        ratio: option.ratio,
      })),
    };
    saveMarketPulse();
  }

  if (MARKET_PULSE.opening && time <= '15:30:00') {
    if (!MARKET_PULSE.anchor) {
      MARKET_PULSE.anchor = {
        time: MARKET_PULSE.opening.time,
        spot: MARKET_PULSE.opening.spot,
        options: MARKET_PULSE.opening.options,
      };
    }

    if (Math.abs(spot - MARKET_PULSE.anchor.spot) >= 50) {
      const from = MARKET_PULSE.anchor;
      const direction = spot > from.spot ? 'UP' : 'DOWN';
      const elapsedSeconds = Math.max(0, Math.round((Date.parse(`1970-01-01T${time}Z`) - Date.parse(`1970-01-01T${from.time}Z`)) / 1000));
      const capture = {
        number: MARKET_PULSE.captures.length + 1,
        fromTime: from.time,
        fromSpot: from.spot,
        toTime: time,
        toSpot: spot,
        elapsedSeconds,
        direction,
        movePoints: parseFloat((spot - from.spot).toFixed(2)),
      options: options.map(option => {
        const opening = from.options.find(item => item.label === option.label);
        const oiChange = option.oi - (opening?.oi || 0);
        const priceChange = option.price - (opening?.price || 0);
        let setup = 'UNCLASSIFIED';
        if (priceChange > 0 && oiChange > 0) setup = 'LONG BUILDUP';
        else if (priceChange < 0 && oiChange > 0) setup = 'SHORT BUILDUP';
        else if (priceChange > 0 && oiChange < 0) setup = 'SHORT COVERING';
        else if (priceChange < 0 && oiChange < 0) setup = 'LONG UNWINDING';

        return {
          label: option.label,
          strike: option.strike,
          type: option.type,
          openingPrice: opening?.price || 0,
          currentPrice: option.price,
          openingOi: opening?.oi || 0,
          currentOi: option.oi,
          oiChange,
          oiChangePct: opening?.oi ? parseFloat(((oiChange / opening.oi) * 100).toFixed(2)) : 0,
          openingBidQty: opening?.bidQty || 0,
          openingAskQty: opening?.askQty || 0,
          openingRatio: opening?.ratio || 0,
          currentBidQty: option.bidQty,
          currentAskQty: option.askQty,
          currentRatio: option.ratio,
          priceChange: parseFloat(priceChange.toFixed(2)),
          setup,
        };
        }),
      };
      MARKET_PULSE.captures.push(capture);
      MARKET_PULSE.anchor = {
        time,
        spot,
        options: options.map(option => ({
          label: option.label,
          strike: option.strike,
          type: option.type,
          price: option.price,
          oi: option.oi,
          bidQty: option.bidQty,
          askQty: option.askQty,
          ratio: option.ratio,
        })),
      };
      saveMarketPulse();
    }
  }

  return MARKET_PULSE;
}

async function loadMaster() {
  let lastError;
  const masterUrls = [
    'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
    'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json',
  ];

  for (const masterUrl of masterUrls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await axios.get(masterUrl, { timeout: 20000 });
        if (!Array.isArray(res.data)) {
          throw new Error('Master response was not an array');
        }

        MASTER = res.data;
        console.log('Master Loaded:', MASTER.length);
        return;
      } catch (error) {
        lastError = error;
        console.warn(`Master download failed from ${masterUrl} (attempt ${attempt}/2):`, error.message);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
  }

  throw lastError;
}

// ============================================================
//  TOTP AUTO-GENERATE
// ============================================================
function generateTOTP() {
  const totp = new TOTP({
    secret: CONFIG.totpSecret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  return totp.generate();
}

// ============================================================
//  ANGEL ONE LOGIN
// ============================================================
async function angelLogin() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await axios.post(
        `${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
        {
          clientcode: CONFIG.clientId,
          password: CONFIG.password,
          totp: generateTOTP(),
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': '127.0.0.1',
            'X-ClientPublicIP': CONFIG.publicIp,
            'X-MACAddress': '00-00-00-00-00-00',
            'X-PrivateKey': CONFIG.apiKey,
          },
        }
      );

      if (res.data.status && res.data.data) {
        SESSION.jwtToken = res.data.data.jwtToken;
        SESSION.refreshToken = res.data.data.refreshToken;
        SESSION.loginTime = Date.now();
        console.log(`[${new Date().toISOString()}] Angel One login successful`);
        return true;
      }

      console.error(`Login failed (attempt ${attempt}/2):`, res.data.message || res.data.errorcode || 'Unknown response');
    } catch (err) {
      const details = err.response?.data?.message || err.response?.data?.errorcode || err.message;
      console.error(`Login error (attempt ${attempt}/2):`, details);
    }

    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return false;
}

// ============================================================
//  TOKEN REFRESH — Every 6 hours
// ============================================================
async function refreshToken() {
  try {
    const res = await axios.post(
      `${ANGEL_BASE}/rest/auth/angelbroking/jwt/v1/generateTokens`,
      { refreshToken: SESSION.refreshToken },
      { headers: getHeaders() }
    );
    if (res.data.status && res.data.data) {
      SESSION.jwtToken = res.data.data.jwtToken;
      SESSION.refreshToken = res.data.data.refreshToken;
      console.log(`[${new Date().toISOString()}] Token refreshed`);
    }
  } catch (err) {
    // If refresh fails — re-login
    await angelLogin();
  }
}

// Auto refresh every 6 hours
setInterval(refreshToken, 6 * 60 * 60 * 1000);

// ============================================================
//  HEADERS HELPER
// ============================================================
function getHeaders() {
  return {
    'Authorization': `Bearer ${SESSION.jwtToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': CONFIG.publicIp,
    'X-MACAddress': '00-00-00-00-00-00',
    'X-PrivateKey': CONFIG.apiKey,
  };
}

// ============================================================
//  ENSURE LOGGED IN
// ============================================================
async function ensureLoggedIn() {
  if (!SESSION.jwtToken) {
    await angelLogin();
  }
}

// ============================================================
//  FETCH NIFTY SPOT PRICE
//  Token 26000 = NIFTY 50
// ============================================================
async function fetchNiftySpot() {
  await ensureLoggedIn();
  const res = await axios.post(
    `${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`,
    {
      mode: 'LTP',
      exchangeTokens: { NSE: ['26000'] },
    },
    { headers: getHeaders() }
  );
  const ltp = res.data.data.fetched[0].ltp;
  return parseFloat(ltp);
}

function findIndiaVixInstrument() {
  return MASTER.find(item => {
    const symbol = String(item.symbol || '').toUpperCase();
    const name = String(item.name || '').toUpperCase();
    return (item.exch_seg === 'NSE' || item.exch_seg === 'NSE_INDEX')
      && (name === 'INDIA VIX' || name === 'INDIAVIX' || symbol === 'INDIAVIX' || symbol.includes('INDIAVIX'));
  });
}

async function fetchIndiaVix(spot) {
  const instrument = findIndiaVixInstrument();
  const token = String(instrument?.token || '26017');
  await ensureLoggedIn();
  const response = await axios.post(
    `${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`,
    {
      mode: 'LTP',
      exchangeTokens: { NSE: [token] },
    },
    { headers: getHeaders() }
  );
  const fetched = response.data?.data?.fetched || [];
  const quote = fetched[0];
  const value = Number(quote?.ltp);
  if (!Number.isFinite(value)) {
    return { available: false, message: `India VIX quote unavailable (token ${token})` };
  }

  resetMarketPulseIfNewDay();
  const previous = MARKET_PULSE.vix?.value || value;
  const opening = MARKET_PULSE.vix?.opening || { value, spot };
  const vixChangePct = opening.value ? ((value - opening.value) / opening.value) * 100 : 0;
  const niftyChangePct = opening.spot ? ((spot - opening.spot) / opening.spot) * 100 : 0;
  const dailyMovePct = value / Math.sqrt(365);
  const expectedMovePoints = spot * dailyMovePct / 100;
  const divergence = vixChangePct - niftyChangePct;
  const inverseMove = vixChangePct > 0.25 && niftyChangePct < -0.1;
  const riskOnMove = vixChangePct < -0.25 && niftyChangePct > 0.1;
  const divergenceLabel = inverseMove
    ? 'RISK-OFF DIVERGENCE'
    : riskOnMove
      ? 'RISK-ON CONFIRMATION'
      : Math.abs(divergence) < 0.15 ? 'CORRELATED / QUIET' : 'MIXED SIGNAL';
  const regime = value < 13 ? 'LOW' : value <= 18 ? 'MODERATE' : value <= 20 ? 'ELEVATED' : 'HIGH';

  const snapshot = {
    available: true,
    value: Number(value.toFixed(2)),
    previous: Number(previous.toFixed(2)),
    change: Number((value - previous).toFixed(2)),
    changePct: Number(((value - previous) / previous * 100).toFixed(2)),
    opening: Number(opening.value.toFixed(2)),
    openingSpot: Number(opening.spot.toFixed(2)),
    vixChangePct: Number(vixChangePct.toFixed(2)),
    niftyChangePct: Number(niftyChangePct.toFixed(2)),
    divergence: Number(divergence.toFixed(2)),
    divergenceLabel,
    regime,
    dailyMovePct: Number(dailyMovePct.toFixed(2)),
    expectedMovePoints: Number(expectedMovePoints.toFixed(0)),
    expectedUpper: Number((spot + expectedMovePoints).toFixed(2)),
    expectedLower: Number((spot - expectedMovePoints).toFixed(2)),
    asOf: new Date().toISOString(),
  };
  MARKET_PULSE.vix = { opening, value, spot, snapshot };
  saveMarketPulse();
  return snapshot;
}

// ============================================================
//  FIND OPTION FROM MASTER
// ============================================================
function findOption(strike, type) {
  const items = MASTER.filter(
    x =>
      x.name === 'NIFTY' &&
      x.instrumenttype === 'OPTIDX' &&
      x.symbol.endsWith(type)
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthIndexes = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const parseExpiry = expiry => {
    const match = String(expiry).match(/^(\d{2})([A-Z]{3})(\d{4})$/);
    if (!match || monthIndexes[match[2]] === undefined) return null;
    return new Date(Number(match[3]), monthIndexes[match[2]], Number(match[1]));
  };
  const expiries = [...new Set(items.map(x => x.expiry))]
    .map(expiry => ({ expiry, date: parseExpiry(expiry) }))
    .filter(item => item.date && item.date >= today)
    .sort((a, b) => a.date - b.date);

  const nearestExpiry = expiries[0]?.expiry;
  if (!nearestExpiry) return undefined;

  return items.find(
    x =>
      x.expiry === nearestExpiry &&
      Number(x.strike) / 100 === strike &&
      x.symbol.endsWith(type)
  );
}

function computeStrengthScores(options) {
  const maxVolume = Math.max(...options.map(o => o.volume || 0), 1);
  const maxOi = Math.max(...options.map(o => o.oi || 0), 1);

  return options.map(opt => {
    const ratio = opt.askQty > 0 ? opt.bidQty / opt.askQty : opt.bidQty;
    const ratioScore = Math.min(ratio, 5) / 5;
    const volumeScore = Math.min(opt.volume / maxVolume, 1);
    const oiScore = Math.min(opt.oi / maxOi, 1);
    const strengthScore = ratioScore * 0.45 + volumeScore * 0.35 + oiScore * 0.2;

    return {
      ...opt,
      strengthScore: parseFloat(strengthScore.toFixed(3)),
      ratioScore: parseFloat(ratioScore.toFixed(3)),
      volumeScore: parseFloat(volumeScore.toFixed(3)),
      oiScore: parseFloat(oiScore.toFixed(3)),
    };
  });
}

function computeSideMetrics(totals) {
  const { bidQty, askQty, volume, oi } = totals;
  const ratio = askQty > 0 ? bidQty / askQty : bidQty;
  return {
    bidQty,
    askQty,
    volume,
    oi,
    ratio: parseFloat(ratio.toFixed(3)),
    sellerPressure: askQty > bidQty,
    buyerPressure: bidQty > askQty,
  };
}

function aggregateTotals(options) {
  const sideTotals = { CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 }, PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 } };
  const tierTotals = { atm: { CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 }, PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 } }, itm1: { CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 }, PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 } } };

  options.forEach(opt => {
    if (!sideTotals[opt.type]) return;
    sideTotals[opt.type].bidQty += opt.bidQty;
    sideTotals[opt.type].askQty += opt.askQty;
    sideTotals[opt.type].volume += opt.volume;
    sideTotals[opt.type].oi += opt.oi;
    if (tierTotals[opt.tier] && tierTotals[opt.tier][opt.type]) {
      tierTotals[opt.tier][opt.type].bidQty += opt.bidQty;
      tierTotals[opt.tier][opt.type].askQty += opt.askQty;
      tierTotals[opt.tier][opt.type].volume += opt.volume;
      tierTotals[opt.tier][opt.type].oi += opt.oi;
    }
  });

  return {
    side: {
      CE: computeSideMetrics(sideTotals.CE),
      PE: computeSideMetrics(sideTotals.PE),
    },
    tier: {
      atm: {
        CE: computeSideMetrics(tierTotals.atm.CE),
        PE: computeSideMetrics(tierTotals.atm.PE),
      },
      itm1: {
        CE: computeSideMetrics(tierTotals.itm1.CE),
        PE: computeSideMetrics(tierTotals.itm1.PE),
      },
    },
  };
}

function computeStrikeTotals(options) {
  const strikeMap = {};

  options.forEach(opt => {
    const key = String(opt.strike);
    if (!strikeMap[key]) {
      strikeMap[key] = {
        strike: opt.strike,
        totals: { bidQty: 0, askQty: 0, volume: 0, oi: 0 },
        typeTotals: {
          CE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 },
          PE: { bidQty: 0, askQty: 0, volume: 0, oi: 0 },
        },
        options: [],
      };
    }

    const strike = strikeMap[key];
    strike.totals.bidQty += opt.bidQty;
    strike.totals.askQty += opt.askQty;
    strike.totals.volume += opt.volume;
    strike.totals.oi += opt.oi;
    if (strike.typeTotals[opt.type]) {
      strike.typeTotals[opt.type].bidQty += opt.bidQty;
      strike.typeTotals[opt.type].askQty += opt.askQty;
      strike.typeTotals[opt.type].volume += opt.volume;
      strike.typeTotals[opt.type].oi += opt.oi;
    }
    strike.options.push(opt);
  });

  return Object.values(strikeMap).map(strike => ({
    strike: strike.strike,
    totals: strike.totals,
    typeTotals: {
      CE: computeSideMetrics(strike.typeTotals.CE),
      PE: computeSideMetrics(strike.typeTotals.PE),
    },
    options: strike.options.map(opt => ({
      label: opt.label,
      type: opt.type,
      tier: opt.tier,
      strike: opt.strike,
      bidQty: opt.bidQty,
      askQty: opt.askQty,
      volume: opt.volume,
      oi: opt.oi,
      ratio: opt.ratio,
      strengthScore: opt.strengthScore,
    })),
  }));
}

function buildTradeSuggestion(options) {
  const aggregates = aggregateTotals(options);
  const strikeTotals = computeStrikeTotals(options);

  const ceStrength = aggregates.side.CE.bidQty / Math.max(aggregates.side.CE.askQty, 1);
  const peStrength = aggregates.side.PE.bidQty / Math.max(aggregates.side.PE.askQty, 1);
  const strongerSide = ceStrength === peStrength ? null : ceStrength > peStrength ? 'CE' : 'PE';

  const strongestOption = options.reduce((best, opt) => {
    return !best || opt.strengthScore > best.strengthScore ? opt : best;
  }, null);

  const suggestedAction = strongestOption
    ? strongestOption.type === 'CE' ? 'BUY CALLS' : 'BUY PUTS'
    : 'NO CLEAR TREND';

  const reason = strongestOption
    ? `${strongestOption.label} is strongest: strength ${strongestOption.strengthScore}, ratio ${strongestOption.ratio}, volume ${strongestOption.volume.toLocaleString()}, OI ${strongestOption.oi.toLocaleString()}`
    : 'Unable to determine a clear strongest option from the available strikes.';

  return {
    aggregates,
    strikeTotals,
    strongerSide,
    strongestOption: strongestOption ? {
      label: strongestOption.label,
      strike: strongestOption.strike,
      type: strongestOption.type,
      tier: strongestOption.tier,
      symbol: strongestOption.symbol,
      strengthScore: strongestOption.strengthScore,
      ratio: strongestOption.ratio,
      volume: strongestOption.volume,
      oi: strongestOption.oi,
    } : null,
    suggestedAction,
    reason,
    riskPoints: 15,
    rewardPoints: 30,
    riskReward: '1:2',
    virtualTrade: !!strongestOption,
  };
}

// ============================================================
//  BUILD NIFTY WEEKLY OPTION SYMBOL
//  Format: NIFTY + DDMMMYY + STRIKE + CE/PE
//  Example: NIFTY06JUN2425100CE
// ============================================================
function getNiftyWeeklyExpiry() {
  // Find next Thursday (weekly expiry)
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  let daysToThursday = (4 - day + 7) % 7;
  if (daysToThursday === 0) daysToThursday = 7; // Already Thursday — next one

  const expiry = new Date(now);
  expiry.setDate(now.getDate() + daysToThursday);

  const dd = String(expiry.getDate()).padStart(2, '0');
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const mmm = months[expiry.getMonth()];
  const yy = String(expiry.getFullYear()).slice(2);

  return `${dd}${mmm}${yy}`; // e.g. 06JUN25
}

function buildOptionSymbol(strike, type) {
  const expiry = getNiftyWeeklyExpiry();
  return `NIFTY${expiry}${strike}${type}`; // e.g. NIFTY06JUN2525100CE
}

// ============================================================
//  FETCH OPTION FULL DATA (Bid/Ask + Volume + LTP)
// ============================================================
async function fetchOptionData(tokens, exchange = 'NFO') {
  await ensureLoggedIn();
  const res = await axios.post(
    `${ANGEL_BASE}/rest/secure/angelbroking/market/v1/quote/`,
    {
      mode: 'FULL', // FULL mode gives bid/ask data
      exchangeTokens: { [exchange]: tokens },
    },
    { headers: getHeaders() }
  );
  return res.data.data.fetched;
}

function findEquityToken(ticker) {
  return MASTER.find(item =>
    item.exch_seg === 'NSE' &&
    (item.symbol === `${ticker}-EQ` || item.name === ticker)
  );
}

function sumDepthQty(entries) {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((sum, item) => sum + (Number(item?.quantity) || Number(item?.qty) || 0), 0);
}

function getOrderFlowStrength(directionValue, bidQty, askQty) {
  const normalizedBid = Number(bidQty) || 0;
  const normalizedAsk = Number(askQty) || 0;
  if (!normalizedBid && !normalizedAsk) return 0;
  if (directionValue > 0) {
    const ratio = normalizedAsk > 0 ? normalizedBid / normalizedAsk : normalizedBid;
    return Math.min(ratio / 3, 1);
  }
  if (directionValue < 0) {
    const ratio = normalizedBid > 0 ? normalizedAsk / normalizedBid : normalizedAsk;
    return Math.min(ratio / 3, 1);
  }
  return 0;
}

function getVolumeConfirmation(currentVolume, avgVolume) {
  const volume = Number(currentVolume) || 0;
  const averageVolume = Number(avgVolume) || 0;
  if (!averageVolume) return 0;
  return Math.min(volume / averageVolume, 1);
}

function getDirectionalOrderFlowSupport(directionValue, bidQty, askQty) {
  const bid = Number(bidQty) || 0;
  const ask = Number(askQty) || 0;
  const total = bid + ask;
  if (!total || directionValue === 0) return 0.5;
  return directionValue > 0 ? bid / total : ask / total;
}

function getBucketDirection(priceReturn) {
  return priceReturn > 0 ? 1 : priceReturn < 0 ? -1 : 0;
}

function getIndiaMinuteBucketKey() {
  const { date, time } = indiaDateTime();
  return `${date}T${time.slice(0, 5)}`;
}

function finalizeSustainabilityBucket(bucket) {
  for (const [ticker, sample] of bucket.stocks.entries()) {
    const latest = sample.latest;
    if (!latest?.price || !sample.firstPrice) continue;

    const priceReturn = ((latest.price - sample.firstPrice) / sample.firstPrice) * 100;
    const direction = getBucketDirection(priceReturn);
    const volumeDelta = latest.volume >= sample.firstVolume
      ? latest.volume - sample.firstVolume
      : latest.volume;
    const history = STOCK_BUCKET_HISTORY.get(ticker) || [];
    history.push({
      timestamp: bucket.key,
      price: latest.price,
      returnPct: Number(priceReturn.toFixed(4)),
      bidQty: latest.bidQty,
      askQty: latest.askQty,
      orderFlow: getDirectionalOrderFlowSupport(direction, latest.bidQty, latest.askQty),
      volume: Math.max(0, volumeDelta),
      avgVolume: latest.avgVolume,
      breadth: bucket.breadth,
      direction,
      gapPct: latest.gapPct,
    });
    STOCK_BUCKET_HISTORY.set(ticker, history.slice(-SUSTAINABILITY_HISTORY_LIMIT));
  }
}

function recordSustainabilityBucket(stocks, breadth) {
  const bucketKey = getIndiaMinuteBucketKey();
  const bucketDate = bucketKey.slice(0, 10);
  if (ACTIVE_SUSTAINABILITY_BUCKET && ACTIVE_SUSTAINABILITY_BUCKET.key.slice(0, 10) !== bucketDate) {
    STOCK_BUCKET_HISTORY.clear();
    ACTIVE_SUSTAINABILITY_BUCKET = null;
  }
  if (ACTIVE_SUSTAINABILITY_BUCKET && ACTIVE_SUSTAINABILITY_BUCKET.key !== bucketKey) {
    finalizeSustainabilityBucket(ACTIVE_SUSTAINABILITY_BUCKET);
    ACTIVE_SUSTAINABILITY_BUCKET = null;
  }
  if (!ACTIVE_SUSTAINABILITY_BUCKET) {
    ACTIVE_SUSTAINABILITY_BUCKET = { key: bucketKey, stocks: new Map(), breadth };
  }
  ACTIVE_SUSTAINABILITY_BUCKET.breadth = breadth;

  for (const stock of stocks) {
    const existing = ACTIVE_SUSTAINABILITY_BUCKET.stocks.get(stock.ticker);
    if (!existing) {
      ACTIVE_SUSTAINABILITY_BUCKET.stocks.set(stock.ticker, {
        firstPrice: stock.price,
        firstVolume: stock.volume,
        latest: stock,
      });
    } else {
      existing.latest = stock;
    }
  }
}

function computeSustainabilityScore(stock, breadth) {
  const returnPct = Number(stock.returnPct ?? stock.dayReturnPct ?? 0) || 0;
  const directionValue = returnPct > 0 ? 1 : returnPct < 0 ? -1 : 0;
  const history = STOCK_BUCKET_HISTORY.get(stock.ticker) || [];
  if (history.length < SUSTAINABILITY_BUCKET_COUNT) {
    return {
      directionPersistence: null,
      orderFlowStrength: null,
      volumeConfirmation: null,
      breadthAlignment: null,
      gapAlignment: null,
      sustainabilityScore: null,
      sustainabilityReady: false,
      sustainabilityBuckets: history.length,
      sustainableBias: 'WARMING UP',
    };
  }

  const buckets = history.slice(-SUSTAINABILITY_BUCKET_COUNT);
  const directionPersistence = buckets.filter(bucket => bucket.direction === directionValue).length / buckets.length;
  const orderFlowStrength = buckets.reduce((sum, bucket) => {
    const support = getDirectionalOrderFlowSupport(directionValue, bucket.bidQty, bucket.askQty);
    return sum + (bucket.direction === directionValue ? support : support * 0.5);
  }, 0) / buckets.length;
  const fallbackMinuteVolume = buckets.reduce((sum, bucket) => sum + bucket.volume, 0) / buckets.length;
  const minuteAverageVolume = Number(stock.avgVolume) > 0
    ? Number(stock.avgVolume) / MARKET_MINUTES_PER_DAY
    : fallbackMinuteVolume;
  const volumeConfirmation = minuteAverageVolume > 0
    ? buckets.reduce((sum, bucket) => {
      const strength = Math.min(bucket.volume / minuteAverageVolume, 1);
      return sum + (bucket.direction === directionValue ? strength : strength * 0.5);
    }, 0) / buckets.length
    : 0;
  const breadthValues = buckets.map(bucket => directionValue > 0
    ? Number(bucket.breadth.weightedUpPct || bucket.breadth.upPct || 0) / 100
    : directionValue < 0
      ? Number(bucket.breadth.weightedDownPct || bucket.breadth.downPct || 0) / 100
      : 0.5);
  const breadthPct = breadthValues.reduce((sum, value) => sum + value, 0) / breadthValues.length;
  const gapAlignment = buckets.reduce((sum, bucket) => {
    const gap = Number(bucket.gapPct) || 0;
    if (!gap || !directionValue) return sum + 0.5;
    return sum + ((gap > 0 && directionValue > 0) || (gap < 0 && directionValue < 0) ? 1 : 0);
  }, 0) / buckets.length;
  const sustainabilityScore = 0.30 * directionPersistence + 0.25 * orderFlowStrength + 0.20 * volumeConfirmation + 0.15 * breadthPct + 0.10 * gapAlignment;
  const sustainableBias = sustainabilityScore >= 0.65
    ? (returnPct > 0 ? 'SUSTAINABLE BULLISH' : returnPct < 0 ? 'SUSTAINABLE BEARISH' : 'WEAK / NOISE')
    : 'WEAK / NOISE';

  return {
    directionPersistence: Number(directionPersistence.toFixed(3)),
    orderFlowStrength: Number(orderFlowStrength.toFixed(3)),
    volumeConfirmation: Number(volumeConfirmation.toFixed(3)),
    breadthAlignment: Number(Math.min(Math.max(breadthPct, 0), 1).toFixed(3)),
    gapAlignment: Number(gapAlignment.toFixed(3)),
    sustainabilityScore: Number(sustainabilityScore.toFixed(3)),
    sustainabilityReady: true,
    sustainabilityBuckets: buckets.length,
    sustainableBias,
  };
}

async function refreshNiftyWeights() {
  const { date } = indiaDateTime();
  if (niftyWeightsRefreshDate === date) return;

  try {
    const response = await axios.get(
      'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json,text/plain,*/*',
          Referer: 'https://www.nseindia.com/',
        },
      }
    );
    const nextWeights = {};
    for (const row of response.data?.data || []) {
      const ticker = String(row.symbol || '').trim();
      const weight = Number(row.weightage ?? row.weight);
      if (ticker && Number.isFinite(weight) && weight > 0 && ticker !== 'NIFTY 50') {
        nextWeights[ticker] = weight;
      }
    }

    if (Object.keys(nextWeights).length < 40) {
      throw new Error('NSE returned an incomplete NIFTY 50 weight list');
    }

    Object.keys(NIFTY_WEIGHTS).forEach(ticker => delete NIFTY_WEIGHTS[ticker]);
    Object.assign(NIFTY_WEIGHTS, nextWeights);
    console.log(`NIFTY weights refreshed from NSE: ${Object.keys(nextWeights).length} constituents`);
  } catch (error) {
    console.warn('NIFTY weight refresh unavailable; using configured weights:', error.message);
  } finally {
    niftyWeightsRefreshDate = date;
  }
}

async function fetchNiftyConstituents() {
  await refreshNiftyWeights();
  const tokenMap = {};
  const missing = [];
  Object.entries(NIFTY_WEIGHTS).forEach(([ticker, weight]) => {
    const equity = findEquityToken(ticker);
    if (!equity) {
      missing.push(ticker);
      return;
    }
    tokenMap[equity.token] = { ticker, weight, symbol: equity.symbol };
  });

  const fetched = Object.keys(tokenMap).length
    ? await fetchOptionData(Object.keys(tokenMap).map(String).slice(0, 50), 'NSE')
    : [];

  const rawStocks = fetched.map(quote => {
    const meta = tokenMap[quote.symbolToken] || {};
    const price = Number(quote.ltp) || 0;
    const previousClose = Number(quote.close) || 0;
    const openingPrice = Number(quote.open) || Number(quote.openPrice) || 0;
    const bidDepth = Array.isArray(quote.depth?.buy) ? quote.depth.buy : [];
    const askDepth = Array.isArray(quote.depth?.sell) ? quote.depth.sell : [];
    const bidQty = sumDepthQty(bidDepth);
    const askQty = sumDepthQty(askDepth);
    const volume = Number(quote.tradeVolume || quote.totalTradedVolume || quote.volume || 0);
    const avgVolume = Number(quote.avgVolume || quote.avgTrdVol || quote.averageTradedVolume || quote.averageVolume || quote.avgTradeVolume || 0);
    const gapPct = previousClose ? ((openingPrice - previousClose) / previousClose) * 100 : null;
    const returnPct = openingPrice ? ((price - openingPrice) / openingPrice) * 100 : null;
    const dayReturnPct = previousClose ? ((price - previousClose) / previousClose) * 100 : null;
    const contribution = (meta.weight * returnPct) / 100;
    const gapContribution = gapPct === null ? null : (meta.weight * gapPct) / 100;
    return {
      ticker: meta.ticker,
      symbol: meta.symbol,
      weight: meta.weight,
      price,
      previousClose,
      openingPrice,
      bidQty,
      askQty,
      volume,
      avgVolume,
      gapPct: gapPct === null ? null : Number(gapPct.toFixed(2)),
      returnPct: returnPct === null ? null : Number(returnPct.toFixed(2)),
      dayReturnPct: dayReturnPct === null ? null : Number(dayReturnPct.toFixed(2)),
      contribution: returnPct === null ? null : Number(contribution.toFixed(4)),
      gapContribution: gapContribution === null ? null : Number(gapContribution.toFixed(4)),
    };
  }).filter(stock => stock.ticker && stock.previousClose > 0 && stock.openingPrice > 0 && stock.returnPct !== null && stock.gapPct !== null);

  const up = rawStocks.filter(stock => stock.returnPct > 0).length;
  const down = rawStocks.filter(stock => stock.returnPct < 0).length;
  const unchanged = rawStocks.length - up - down;
  const gapUp = rawStocks.filter(stock => stock.gapPct > 0).length;
  const gapDown = rawStocks.filter(stock => stock.gapPct < 0).length;
  const gapFlat = rawStocks.length - gapUp - gapDown;
  const totalMove = rawStocks.reduce((sum, stock) => sum + stock.contribution, 0);
  const totalGap = rawStocks.reduce((sum, stock) => sum + stock.gapContribution, 0);
  const breadth = {
    up,
    down,
    unchanged,
    total: rawStocks.length,
    upPct: rawStocks.length ? Number((up / rawStocks.length * 100).toFixed(1)) : 0,
    downPct: rawStocks.length ? Number((down / rawStocks.length * 100).toFixed(1)) : 0,
    unchangedPct: rawStocks.length ? Number((unchanged / rawStocks.length * 100).toFixed(1)) : 0,
  };
  const totalWeight = rawStocks.reduce((sum, stock) => sum + (Number(stock.weight) || 0), 0);
  const bullishWeight = rawStocks.filter(stock => stock.returnPct > 0).reduce((sum, stock) => sum + stock.weight, 0);
  const bearishWeight = rawStocks.filter(stock => stock.returnPct < 0).reduce((sum, stock) => sum + stock.weight, 0);
  breadth.weightedUpPct = totalWeight ? Number((bullishWeight / totalWeight * 100).toFixed(1)) : 0;
  breadth.weightedDownPct = totalWeight ? Number((bearishWeight / totalWeight * 100).toFixed(1)) : 0;
  breadth.weightedTotalWeight = Number(totalWeight.toFixed(3));
  const gapBreadth = {
    up: gapUp,
    down: gapDown,
    unchanged: gapFlat,
    upPct: rawStocks.length ? Number((gapUp / rawStocks.length * 100).toFixed(1)) : 0,
    downPct: rawStocks.length ? Number((gapDown / rawStocks.length * 100).toFixed(1)) : 0,
    unchangedPct: rawStocks.length ? Number((gapFlat / rawStocks.length * 100).toFixed(1)) : 0,
  };

  recordSustainabilityBucket(rawStocks, breadth);
  const stocksWithSustainability = rawStocks.map(stock => ({
    ...stock,
    ...computeSustainabilityScore(stock, breadth),
  }));

  const sustainableStocks = stocksWithSustainability
    .filter(stock => stock.sustainabilityScore >= 0.65)
    .sort((a, b) => b.sustainabilityScore - a.sustainabilityScore);

  const totalStocks = Math.max(rawStocks.length, 1);
  const sustainablePct = Number(((sustainableStocks.length / totalStocks) * 100).toFixed(1));
  const bullishSustainable = sustainableStocks.filter(stock => stock.returnPct > 0).length;
  const bearishSustainable = sustainableStocks.filter(stock => stock.returnPct < 0).length;
  const weakStocks = stocksWithSustainability.filter(stock => stock.sustainabilityScore < 0.65).length;

  const signal = totalMove > STRONG_WEIGHTED_MOVE ? 'STRONG BULLISH'
    : totalMove > MILD_WEIGHTED_MOVE ? 'MILD BULLISH'
      : totalMove > -MILD_WEIGHTED_MOVE ? 'NEUTRAL'
        : totalMove > -STRONG_WEIGHTED_MOVE ? 'MILD BEARISH' : 'STRONG BEARISH';

  const currentBias = totalMove > 0 ? 'BULLISH' : totalMove < 0 ? 'BEARISH' : 'NEUTRAL';
  const sustainabilityStatus = currentBias;

  return {
    stocks: sustainableStocks,
    allStocks: stocksWithSustainability.sort((a, b) => b.weight - a.weight),
    sustainableCount: sustainableStocks.length,
    sustainablePct,
    weakStocks,
    bullishSustainable,
    bearishSustainable,
    totalMove: Number(totalMove.toFixed(3)),
    totalGap: Number(totalGap.toFixed(3)),
    signal,
    sustainabilityStatus,
    currentBias,
    breadth,
    gapBreadth,
    missing,
    capturedAt: new Date().toISOString(),
  };
}

// ============================================================
//  GET ATM STRIKE
// ============================================================
function getATMStrike(spot) {
  return Math.round(spot / 50) * 50;
}

// ============================================================
//  API ROUTE: /api/marketdata
//  Dashboard yahan se data fetch karega
// ============================================================
app.get('/api/marketdata', async (req, res) => {
  try {
    if (!MASTER.length) {
      await loadMaster();
    }

    // 1. Fetch NIFTY spot
    const spot = await fetchNiftySpot();
    const vixPromise = fetchIndiaVix(spot).catch(vixError => {
      console.error('India VIX data error:', vixError.message);
      return { available: false, message: vixError.message };
    });
    const atm = getATMStrike(spot);
    const itm1 = atm - 50;
    const itm2 = atm - 100;
    const itm1Pe = atm + 50;
    const itm2Pe = atm + 100;

    // 2. Build option symbols
    const contracts = [
      { label: 'ATM CE', strike: atm,    type: 'CE', tier: 'atm'  },
      { label: 'ATM PE', strike: atm,    type: 'PE', tier: 'atm'  },
      { label: '1 ITM CE', strike: itm1, type: 'CE', tier: 'itm1' },
      { label: '1 ITM PE', strike: itm1Pe, type: 'PE', tier: 'itm1' },
      { label: '2 ITM CE', strike: itm2, type: 'CE', tier: 'itm2' },
      { label: '2 ITM PE', strike: itm2Pe, type: 'PE', tier: 'itm2' },
    ];

    // 3. Find tokens for each option
    const tokenMap = {};
    for (const c of contracts) {
      const option = findOption(c.strike, c.type);
      if (option) {
        tokenMap[option.token] = {
          ...c,
          symbol: option.symbol,
        };
      }
    }

    const tokens = Object.keys(tokenMap);

    if (tokens.length === 0) {
      return res.json({ success: false, message: 'No option tokens found — market may be closed or expiry mismatch' });
    }

    // Fetch independent quote sets in parallel so the slowest request controls total latency.
    const constituentSignalPromise = fetchNiftyConstituents().catch(constituentError => {
      console.error('Nifty constituent data error:', constituentError.message);
      return {
        stocks: [],
        totalMove: 0,
        totalGap: 0,
        signal: 'DATA UNAVAILABLE',
        breadth: { up: 0, down: 0, unchanged: 0, total: 0, upPct: 0, downPct: 0, unchangedPct: 0 },
        gapBreadth: { up: 0, down: 0, unchanged: 0, upPct: 0, downPct: 0, unchangedPct: 0 },
        missing: Object.keys(NIFTY_WEIGHTS),
        capturedAt: new Date().toISOString(),
      };
    });
    const optionData = await fetchOptionData(tokens);
    const vix = await vixPromise;
    const debug = req.query.debug === '1' || req.query.debug === 'true';

    function sumDepthQty(entries) {
      if (!Array.isArray(entries)) return 0;
      return entries.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0);
    }

    function describeDepth(entries) {
      if (!Array.isArray(entries)) return { count: 0, total: 0, levels: [] };
      const levels = entries.map(item => ({ price: item?.price || null, quantity: Number(item?.quantity) || 0 }));
      return {
        count: levels.length,
        total: levels.reduce((sum, level) => sum + level.quantity, 0),
        levels,
      };
    }

    // 5. Build response with strength scoring
    const rawOptions = optionData.map(opt => {
      const meta = tokenMap[opt.symbolToken] || {};
      const bidDepth = describeDepth(opt.depth?.buy);
      const askDepth = describeDepth(opt.depth?.sell);
      const bidQty = bidDepth.total;
      const askQty = askDepth.total;
      const ratio = askQty > 0 ? parseFloat((bidQty / askQty).toFixed(3)) : 0;
      const priceChange = parseFloat((opt.ltp - opt.close).toFixed(2));
      const pctChange = opt.close > 0
        ? parseFloat(((priceChange / opt.close) * 100).toFixed(2))
        : 0;

      if (debug) {
        console.log(`DEBUG ${meta.label || opt.symbolToken}: buyCount=${bidDepth.count} buyTotal=${bidQty} sellCount=${askDepth.count} sellTotal=${askQty}`);
      }

      const volume = Number(opt.tradeVolume || opt.volume || 0);
      const oi = Number(opt.opnInterest || opt.openInterest || opt.oi || 0);
      return {
        label: meta.label,
        tier: meta.tier,
        strike: meta.strike,
        type: meta.type,
        symbol: meta.symbol,
        price: opt.ltp,
        prevPrice: opt.close,
        bidQty,
        askQty,
        ratio,
        volume,
        avgVolume: Number(opt.averageTradedPrice || 0) * 100,
        volumeSpike: volume > (Number(opt.averageTradedPrice || 0) * 100),
        priceChange,
        pctChange,
        high: opt.high,
        low: opt.low,
        oi,
        bidDepthCount: bidDepth.count,
        askDepthCount: askDepth.count,
        bidDepthLevels: debug ? bidDepth.levels : undefined,
        askDepthLevels: debug ? askDepth.levels : undefined,
      };
    });

    const options = computeStrengthScores(rawOptions);
    const suggestion = buildTradeSuggestion(options);
    const marketPulse = captureMarketPulse(spot, options);
    const constituentSignal = await constituentSignalPromise;
    MARKET_PULSE.constituentSignal = constituentSignal;
    saveMarketPulse();

    return res.json({ success: true, spot, atm, options, suggestion, marketPulse, constituentSignal, vix });

  } catch (err) {
    console.error('Market data error:', err.message);

    // If token expired — re-login and retry once
    if (err.response?.status === 401) {
      await angelLogin();
      return res.json({ success: false, message: 'Session expired — retrying login. Refresh in 5 seconds.' });
    }

    return res.json({ success: false, message: err.message });
  }
});

// ============================================================
//  API ROUTE: /api/status
// ============================================================
app.get('/api/status', (req, res) => {
  res.json({
    loggedIn: !!SESSION.jwtToken,
    loginTime: SESSION.loginTime,
    serverTime: new Date().toISOString(),
  });
});

app.get('/api/market-pulse', (req, res) => {
  resetMarketPulseIfNewDay();
  res.json({ success: true, marketPulse: MARKET_PULSE });
});

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);

  try {
    await loadMaster();

    const ok = await angelLogin();
    if (!ok) {
      console.warn('Angel login failed on startup. Dashboard will still load, but live market data requires valid credentials in .env.');
    }
  } catch (error) {
    console.warn('Startup initialization warning:', error.message || 'Unknown startup issue');
  }
});
