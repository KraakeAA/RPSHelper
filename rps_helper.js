// rps_helper.js
// This is a new, separate file for your Rock Paper Scissors bot.

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.RPS_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_ID = BOT_TOKEN.split(':')[0];

if (!BOT_TOKEN || !DATABASE_URL) {
    console.error("RPS HELPER: CRITICAL: RPS_BOT_TOKEN or DATABASE_URL is missing.");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_REJECT_UNAUTHORIZED === 'true' } : false,
});

const activeHelperGames = new Map();

// --- GAME CONSTANTS (Copied from main bot) ---
const RPS_CHOICES = {
    ROCK: 'rock',
    PAPER: 'paper',
    SCISSORS: 'scissors'
};
const RPS_EMOJIS = {
    [RPS_CHOICES.ROCK]: '🪨',
    [RPS_CHOICES.PAPER]: '📄',
    [RPS_CHOICES.SCISSORS]: '✂️'
};
const RPS_RULES = {
    [RPS_CHOICES.ROCK]: { beats: RPS_CHOICES.SCISSORS, verb: "crushes" },
    [RPS_CHOICES.PAPER]: { beats: RPS_CHOICES.ROCK, verb: "covers" },
    [RPS_CHOICES.SCISSORS]: { beats: RPS_CHOICES.PAPER, verb: "cuts" }
};
const ACTIVE_GAME_TURN_TIMEOUT_MS = parseInt(process.env.ACTIVE_GAME_TURN_TIMEOUT_MS, 10) || 45000;

// --- UTILITY FUNCTIONS ---
function escapeHTML(text) {
    if (text === null || typeof text === 'undefined') return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (e) {
        console.error(`[RPS Helper] Failed to send message to ${chatId}: ${e.message}`);
        return null;
    }
}

function getPlayerDisplayReference(userObject) {
    if (!userObject) return "Mystery Player";
    const username = userObject.username;
    if (username) {
        return `@${username}`;
    }
    return userObject.first_name || `Player ${String(userObject.id || userObject.telegram_id).slice(-4)}`;
}

function getRandomRPSChoice() {
    const choicesArray = Object.values(RPS_CHOICES);
    return choicesArray[Math.floor(Math.random() * choicesArray.length)];
}

function determineRPSOutcome(player1ChoiceKey, player2ChoiceKey, player1NameHtml = "Player 1", player2NameHtml = "Player 2") {
    const p1c = String(player1ChoiceKey).toLowerCase();
    const p2c = String(player2ChoiceKey).toLowerCase();
    if (!Object.values(RPS_CHOICES).includes(p1c) || !Object.values(RPS_CHOICES).includes(p2c)) {
        return { result: 'error', description: "An internal error occurred." };
    }

    if (p1c === p2c) {
        return { result: 'draw', description: "It's a Draw!" };
    } else if (RPS_RULES[p1c]?.beats === p2c) {
        return { result: 'win_player1', description: `${player1NameHtml}'s ${RPS_EMOJIS[p1c]} ${RPS_RULES[p1c].verb} ${RPS_EMOJIS[p2c]}!` };
    } else {
        return { result: 'win_player2', description: `${player2NameHtml}'s ${RPS_EMOJIS[p2c]} ${RPS_RULES[p2c].verb} ${RPS_EMOJIS[p1c]}!` };
    }
}

// --- DATABASE INTERACTION ---

async function finalizeAndRecordOutcome(sessionId, finalStatus, finalGameState = {}) {
    const logPrefix = `[RPSHelper_Finalize SID:${sessionId}]`;
    console.log(`${logPrefix} Finalizing game with status: ${finalStatus}`);
    try {
        await pool.query(
            "UPDATE rps_sessions SET status = $1, game_state_json = $2, updated_at = NOW() WHERE session_id = $3",
            [finalStatus, JSON.stringify(finalGameState), sessionId]
        );
        activeHelperGames.delete(sessionId);
    } catch (e) {
        console.error(`${logPrefix} CRITICAL: Failed to write final outcome to DB: ${e.message}`);
    }
}


// --- CORE GAME LOGIC ---

/**
 * Starts a Player vs. Bot game.
 * @param {object} session - The game session object.
 */
async function runRPSPvB(session) {
    const gameState = session.game_state_json;
    const playerRefHTML = escapeHTML(gameState.initiatorName);
    
    gameState.status = 'pvb_awaiting_player_choice';
    activeHelperGames.set(session.session_id, session);

    const messageText = `🤖 <b>RPS vs. Bot!</b>\n\n${playerRefHTML}, make your move! Choose your weapon below.`;
    const keyboard = {
        inline_keyboard: [[
            { text: RPS_EMOJIS.rock, callback_data: `rps_helper_pvb_choice:${session.session_id}:${RPS_CHOICES.ROCK}` },
            { text: RPS_EMOJIS.paper, callback_data: `rps_helper_pvb_choice:${session.session_id}:${RPS_CHOICES.PAPER}` },
            { text: RPS_EMOJIS.scissors, callback_data: `rps_helper_pvb_choice:${session.session_id}:${RPS_CHOICES.SCISSORS}` }
        ]]
    };

    await bot.editMessageText(messageText, { chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML', reply_markup: keyboard });
    
    session.timeoutId = setTimeout(() => handleGameTimeout(session.session_id, 'pvb_player_turn'), ACTIVE_GAME_TURN_TIMEOUT_MS);
}

/**
 * Starts a Player vs. Player game by DMing both players.
 * @param {object} session - The game session object.
 */
async function runRPSPvP(session) {
    const gameState = session.game_state_json;
    const p1_id = session.initiator_id;
    const p2_id = session.opponent_id;
    const p1_name = escapeHTML(gameState.initiatorName);
    const p2_name = escapeHTML(gameState.opponentName);

    gameState.status = 'pvp_awaiting_choices';
    gameState.p1_choice = null;
    gameState.p2_choice = null;
    activeHelperGames.set(session.session_id, session);

    await bot.editMessageText(`⚔️ <b>RPS Duel Started!</b>\n\n${p1_name} vs. ${p2_name}\n\nI have sent a private message to both players to make their secret choice. The results will be revealed here once both have chosen!`, {
        chat_id: session.chat_id,
        message_id: gameState.helperMessageId,
        parse_mode: 'HTML',
        reply_markup: {}
    });

    const choiceKeyboard = {
        inline_keyboard: [[
            { text: RPS_EMOJIS.rock, callback_data: `rps_helper_pvp_submit:${session.session_id}:${RPS_CHOICES.ROCK}` },
            { text: RPS_EMOJIS.paper, callback_data: `rps_helper_pvp_submit:${session.session_id}:${RPS_CHOICES.PAPER}` },
            { text: RPS_EMOJIS.scissors, callback_data: `rps_helper_pvp_submit:${session.session_id}:${RPS_CHOICES.SCISSORS}` }
        ]]
    };

    // DM both players
    await safeSendMessage(p1_id, `Your RPS duel against ${p2_name} is ready! Make your secret choice:`, { reply_markup: choiceKeyboard });
    await safeSendMessage(p2_id, `Your RPS duel against ${p1_name} is ready! Make your secret choice:`, { reply_markup: choiceKeyboard });
    
    session.timeoutId = setTimeout(() => handleGameTimeout(session.session_id, 'pvp_choices'), ACTIVE_GAME_TURN_TIMEOUT_MS);
}

/**
 * Handles the timeout for a game.
 * @param {number} sessionId - The ID of the game session.
 * @param {string} context - The context of the timeout (e.g., 'offer', 'pvb_player_turn').
 */
async function handleGameTimeout(sessionId, context) {
    const session = activeHelperGames.get(sessionId);
    if (!session) return;

    if (context === 'offer') {
         await bot.editMessageText(`⏳ This RPS offer has expired unanswered.`, { chat_id: session.chat_id, message_id: session.game_state_json.helperMessageId, parse_mode: 'HTML' });
        await finalizeAndRecordOutcome(sessionId, 'completed_timeout', session.game_state_json);
    } else if (context === 'pvb_player_turn') {
        await bot.editMessageText(`⏳ Player timed out. The Bot wins by default.`, { chat_id: session.chat_id, message_id: session.game_state_json.helperMessageId, parse_mode: 'HTML' });
        await finalizeAndRecordOutcome(sessionId, 'completed_bot_win', session.game_state_json);
    } else if (context === 'pvp_choices') {
         await bot.editMessageText(`⏳ The RPS duel timed out because one or both players did not make a choice. The game is a push.`, { chat_id: session.chat_id, message_id: session.game_state_json.helperMessageId, parse_mode: 'HTML' });
        await finalizeAndRecordOutcome(sessionId, 'completed_push', session.game_state_json);
    }
}


// --- MAIN HANDLERS ---

/**
 * The entry point for the helper bot when it picks up a new game session.
 * @param {string} mainBotGameId - The unique game ID from the main bot.
 */
async function handleNewGameSession(mainBotGameId) {
    const logPrefix = `[RPSHelper_HandleNew GID:${mainBotGameId}]`;
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const sessionRes = await client.query(
            "UPDATE rps_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE main_bot_game_id = $2 AND status = 'pending_pickup' RETURNING *",
            [BOT_ID, mainBotGameId]
        );

        if (sessionRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return;
        }
        const session = sessionRes.rows[0];
        await client.query('COMMIT');
        
        activeHelperGames.set(session.session_id, session);
        
        if (session.opponent_id) {
            await runDirectChallenge(session);
        } else {
            await runUnifiedOffer(session);
        }

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error handling new session: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const [action, sessionIdStr, ...params] = data.split(':');
    const sessionId = parseInt(sessionIdStr, 10);
    const clickerId = String(callbackQuery.from.id);

    const session = activeHelperGames.get(sessionId);
    if (!session) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "This game is no longer active.", show_alert: true });
        return;
    }
    if (session.timeoutId) clearTimeout(session.timeoutId);

    const gameState = session.game_state_json || {};

    // --- Unified Offer Callbacks ---
    if (action === 'cf_helper_cancel' && clickerId === String(session.initiator_id)) {
        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.deleteMessage(session.chat_id, gameState.helperMessageId).catch(() => {});
        await finalizeAndRecordOutcome(sessionId, 'completed_cancelled', gameState);
    } else if (action === 'cf_helper_accept_bot' && clickerId === String(session.initiator_id)) {
        await bot.answerCallbackQuery(callbackQuery.id);
        await runRPSPvB(session);
    } else if (action === 'cf_helper_accept_pvp' && clickerId !== String(session.initiator_id)) {
        session.opponent_id = clickerId;
        gameState.opponentName = getPlayerDisplayReference(callbackQuery.from);
        await bot.answerCallbackQuery(callbackQuery.id);
        await runRPSPvP(session);
    } 
    // --- Direct Challenge Callbacks ---
    else if (action === 'cf_helper_accept_direct' && clickerId === String(session.opponent_id)) {
        await bot.answerCallbackQuery(callbackQuery.id);
        await runRPSPvP(session);
    } else if (action === 'cf_helper_decline_direct' && clickerId === String(session.opponent_id)) {
        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.editMessageText(`🚫 ${escapeHTML(gameState.opponentName)} declined the duel.`, {chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML'});
        await finalizeAndRecordOutcome(sessionId, 'completed_cancelled', gameState);
    }
    // --- Game Action Callbacks ---
    else if (action === 'rps_helper_pvb_choice') {
        if (clickerId === String(session.initiator_id)) {
            await bot.answerCallbackQuery(callbackQuery.id);
            const playerChoice = params[0];
            const botChoice = getRandomRPSChoice();
            const outcome = determineRPSOutcome(playerChoice, botChoice, gameState.initiatorName, 'Bot');
            const finalStatus = outcome.result === 'win_player1' ? 'completed_p1_win' : (outcome.result === 'draw' ? 'completed_push' : 'completed_bot_win');
            
            await bot.editMessageText(`<b>RPS Result!</b>\n\nYou chose: ${RPS_EMOJIS[playerChoice]}\nBot chose: ${RPS_EMOJIS[botChoice]}\n\n${outcome.description}\n\nThe main bot will now settle the wager.`, {chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML'});
            await finalizeAndRecordOutcome(sessionId, finalStatus, { ...gameState, p1_choice: playerChoice, bot_choice: botChoice });
        }
    } else if (action === 'rps_helper_pvp_submit') {
        const choice = params[0];
        let playerKey = null;
        if(clickerId === String(session.initiator_id)) playerKey = 'p1_choice';
        else if (clickerId === String(session.opponent_id)) playerKey = 'p2_choice';
        
        if(playerKey && !gameState[playerKey]) {
            gameState[playerKey] = choice;
            await bot.answerCallbackQuery(callbackQuery.id, {text: "Your choice is locked in!"});
            await bot.editMessageText("Your choice has been locked in secretly.", {chat_id: clickerId, message_id: callbackQuery.message.message_id, reply_markup: {}});
            
            if(gameState.p1_choice && gameState.p2_choice) {
                if (session.timeoutId) clearTimeout(session.timeoutId);
                const p1_name = escapeHTML(gameState.initiatorName);
                const p2_name = escapeHTML(gameState.opponentName);
                const outcome = determineRPSOutcome(gameState.p1_choice, gameState.p2_choice, p1_name, p2_name);
                const finalStatus = outcome.result === 'win_player1' ? 'completed_p1_win' : (outcome.result === 'win_player2' ? 'completed_p2_win' : 'completed_push');
                
                await bot.editMessageText(`<b>RPS Duel Result!</b>\n\n${p1_name} chose: ${RPS_EMOJIS[gameState.p1_choice]}\n${p2_name} chose: ${RPS_EMOJIS[gameState.p2_choice]}\n\n${outcome.description}\n\nThe main bot will settle the wagers.`, {chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML'});
                await finalizeAndRecordOutcome(sessionId, finalStatus, gameState);
            }
        } else {
             await bot.answerCallbackQuery(callbackQuery.id, {text: "You have already made a choice.", show_alert: true});
        }
    }
});

// --- MAIN LISTENER ---

async function listenForNewGames() {
    const client = await pool.connect();
    client.on('notification', (msg) => {
        if (msg.channel === 'rps_session_pickup') {
            try {
                const payload = JSON.parse(msg.payload);
                if (payload.main_bot_game_id) {
                    console.log(`[RPSHelper] Received pickup notification for ${payload.main_bot_game_id}`);
                    handleNewGameSession(payload.main_bot_game_id);
                }
            } catch (e) {
                console.error("[RPSHelper] Error parsing notification payload:", e);
            }
        }
    });
    await client.query('LISTEN rps_session_pickup');
    const self = await bot.getMe();
    console.log(`✅ RPS Helper Bot (@${self.username}) is online and listening for games...`);
}

listenForNewGames().catch(e => {
    console.error("FATAL: Failed to start RPS Helper listener:", e);
    process.exit(1);
});
