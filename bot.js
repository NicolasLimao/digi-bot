const { Client, GatewayIntentBits, ChannelType, Partials } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// URLs e IDs (preencha via variáveis de ambiente)
const RAG_API_URL = process.env.RAG_API_URL || 'http://localhost:8000/api/rag/query';
const FEEDBACK_API_URL = RAG_API_URL.replace('/query', '/feedback');
const INGEST_API_URL = (() => {
  try { return new URL(RAG_API_URL).origin + '/api/ingest'; }
  catch { return 'http://localhost:8000/api/ingest'; }
})();

const CANAL_INGESTAO = process.env.CANAL_INGESTAO || '1491637301522989198';
const CANAL_CONSULTA = process.env.CANAL_CONSULTA || '1491637352513142914';

// A API exige X-API-Key em todas as rotas /api/* quando roda em produção
const API_HEADERS = process.env.API_AUTH_TOKEN
  ? { 'X-API-Key': process.env.API_AUTH_TOKEN }
  : {};

// Mapeia: id da mensagem de resposta do bot -> interaction_id (para gravar feedback)
const feedbackMap = new Map();

console.log('[Bot] Iniciando...');
console.log('[Bot] RAG API URL:', RAG_API_URL);
console.log('[Bot] Feedback API URL:', FEEDBACK_API_URL);
console.log('[Bot] Ingest API URL:', INGEST_API_URL);

// Event: Bot conecta
client.on('ready', () => {
  console.log(`[Bot] ✅ Conectado como ${client.user.tag}`);
  console.log('[Bot] Escutando mensagens...');
});

// Quebra um texto longo em pedaços de até 1900 chars (limite do Discord)
function dividirMensagem(texto) {
  if (texto.length <= 1900) return [texto];
  const partes = [];
  let atual = '';
  texto.split('\n').forEach((linha) => {
    if ((atual + linha).length > 1900) {
      partes.push(atual);
      atual = linha;
    } else {
      atual += (atual ? '\n' : '') + linha;
    }
  });
  if (atual) partes.push(atual);
  return partes;
}

// Consulta o RAG, responde, e adiciona reações de feedback
async function handleRagQuery(message, userId, query, canal, logPrefix) {
  // Typing e cosmetico: um erro do Discord aqui nao pode abortar a resposta
  try {
    await message.channel.sendTyping();
  } catch (e) {
    console.error(`${logPrefix} Falha no sendTyping (ignorado): ${e.message}`);
  }

  try {
    const url = new URL(RAG_API_URL);
    url.searchParams.append('user_id', userId);
    url.searchParams.append('canal', canal);

    const response = await axios.post(url.toString(), { query }, { timeout: 60000, headers: API_HEADERS });

    const result = response.data;
    const responseText = result.response || 'Sem resposta';
    const score = (result.score || 0).toFixed(2);
    const chunks = result.chunks_used || 0;
    const time = result.processing_time_ms || 0;

    console.log(`${logPrefix} ✅ Resposta (score=${score}, chunks=${chunks}, time=${time}ms)`);

    const partes = dividirMensagem(responseText);
    let sentMsg;
    for (const parte of partes) {
      sentMsg = await message.reply(parte);
    }
    console.log(`${logPrefix} Enviada(s) ${partes.length} mensagem(ns)`);

    // Reações de feedback na resposta
    if (sentMsg && result.interaction_id) {
      try {
        await sentMsg.react('✅');
        await sentMsg.react('❌');
        feedbackMap.set(sentMsg.id, result.interaction_id);
      } catch (e) {
        console.error(`${logPrefix} Erro ao adicionar reações: ${e.message}`);
      }
    }

  } catch (error) {
    console.error(`${logPrefix} ❌ Erro: ${error.message}`);

    if (error.message.includes('ECONNREFUSED')) {
      await message.reply('❌ Servidor RAG offline. Tente novamente em alguns segundos.');
    } else if (error.code === 'ENOTFOUND') {
      await message.reply('❌ Erro de conexão com o servidor RAG.');
    } else if (error.code === 'ETIMEDOUT') {
      await message.reply('⏱️ Pergunta demorou muito para processar.');
    } else {
      await message.reply('❌ Erro ao processar pergunta. Tente novamente.');
    }
  }
}

// Event: Mensagem recebida
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  try {
    // 1. CANAL DE INGESTÃO - chama a API Python (substituiu o n8n)
    if (message.channelId === CANAL_INGESTAO) {
      console.log(`[Ingestao] Recebido de ${message.author.username} (anexos: ${message.attachments.size})`);
      const tInicio = Date.now();

      // Mensagem inicial (editamos no fim — evita rate limit do Discord)
      let ack;
      try {
        ack = await message.reply('📥 Recebido, processando ingestão...');
      } catch (e) {
        console.error(`[Ingestao] Falha ao confirmar recebimento: ${e.message}`);
      }

      const payload = {
        content: message.content || null,
        attachments: message.attachments.map(a => ({
          url: a.url,
          filename: a.name,
          contentType: a.contentType
        }))
      };

      try {
        // Timeout alto: PDFs grandes podem levar minutos (extração + embedding + insert)
        const response = await axios.post(INGEST_API_URL, payload, { timeout: 600000, headers: API_HEADERS });
        const r = response.data;
        const elapsed = ((Date.now() - tInicio) / 1000).toFixed(1);
        const fontes = (r.sources || []).map(s => `${s.source} (${s.chunks})`).join(', ');
        const avisos = (r.errors || []).slice(0, 3).join('; ');

        let msg = `✅ Ingestão concluída em **${elapsed}s**\n**${r.chunks_created} chunks** criados (${(r.total_chars || 0).toLocaleString('pt-BR')} chars)`;
        if (fontes) msg += `\n📄 Fontes: ${fontes}`;
        if (avisos) msg += `\n⚠️ Avisos: ${avisos}`;
        if (msg.length > 1900) msg = msg.substring(0, 1900);

        if (ack) await ack.edit(msg);
        else await message.reply(msg);
        console.log(`[Ingestao] ✅ ${r.chunks_created} chunks em ${elapsed}s`);
      } catch (error) {
        const detail = error.response?.data?.detail || error.message;
        const msg = `❌ Falha na ingestão: ${String(detail).substring(0, 400)}`;
        console.error(`[Ingestao] ❌ ${error.message}`);
        try {
          if (ack) await ack.edit(msg);
          else await message.reply(msg);
        } catch (e) {
          console.error(`[Ingestao] Falha ao reportar erro: ${e.message}`);
        }
      }
      return;
    }

    // 2. CANAL DE CONSULTA - Python RAG
    if (message.channelId === CANAL_CONSULTA) {
      console.log(`[Consulta] ${message.author.username}: ${message.content.substring(0, 50)}...`);
      await handleRagQuery(message, message.author.id, message.content, 'canal', '[Consulta]');
      return;
    }

    // 3. DMs (Privadas) - Python RAG
    if (message.channel.type === ChannelType.DM) {
      console.log(`[DM] ${message.author.username} (${message.author.id}): ${message.content.substring(0, 50)}...`);
      await handleRagQuery(message, message.author.id, message.content, 'dm', '[DM]');
      return;
    }

  } catch (error) {
    console.error('[Error]', error);
  }
});

// Event: Reação adicionada (feedback 👍/👎)
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch (e) { return; }
    }

    const interactionId = feedbackMap.get(reaction.message.id);
    if (!interactionId) return;

    let feedback = null;
    if (reaction.emoji.name === '✅') feedback = 'positivo';
    else if (reaction.emoji.name === '❌') feedback = 'negativo';
    if (!feedback) return;

    await axios.post(FEEDBACK_API_URL, { interaction_id: interactionId, feedback }, { timeout: 10000, headers: API_HEADERS });
    console.log(`[Feedback] ${feedback} registrado para ${interactionId}`);

  } catch (error) {
    console.error(`[Feedback] ❌ Erro: ${error.message}`);
  }
});

client.on('error', error => {
  console.error('[Client Error]', error);
});

process.on('unhandledRejection', error => {
  console.error('[Unhandled Rejection]', error);
});

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('[Bot] DISCORD_BOT_TOKEN não definido. Encerrando.');
  process.exit(1);
}
client.login(token);

process.on('SIGINT', () => {
  console.log('\n[Bot] Desligando...');
  client.destroy();
  process.exit(0);
});
