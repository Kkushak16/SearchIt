// Background Service Worker for SearchIt Extension

// Initialize database
let db = null;
const DB_NAME = 'WhatsAppSemanticSearch';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

function openDatabase() {
  if (db) return Promise.resolve(db);
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (event) => {
      console.error('IndexedDB open error in background:', event.target.error);
      reject(event.target.error);
    };
    
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('chatId', 'chatId', { unique: false });
        store.createIndex('processed', 'processed', { unique: false });
        console.log('IndexedDB schema created in background.');
      }
    };
  });
}

// Run cleanup on service worker startup
openDatabase().then(() => cleanupOldMessages()).catch(console.error);

// Listen for message events
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getEmbedding') {
    handleGetEmbedding(request.text, request.isBatch || false, request.config)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => {
        console.error('Embedding error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open
  } else if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  } else if (request.action === 'storeMessages') {
    storeMessages(request.messages)
      .then(count => sendResponse({ success: true, count }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  } else if (request.action === 'getIndexedCount') {
    getIndexedCount(request.chatId)
      .then(counts => sendResponse({ success: true, counts }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  } else if (request.action === 'processEmbeddings') {
    processPendingEmbeddings(request.chatId)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  } else if (request.action === 'performSearch') {
    performSemanticSearch(request.chatId, request.query)
      .then(results => sendResponse({ success: true, results }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  } else if (request.action === 'clearChatData') {
    clearChatData(request.chatId)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  } else if (request.action === 'clearAllDatabase') {
    clearAllDatabase()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ==========================================
// BACKGROUND DATABASE OPERATIONS
// ==========================================

function storeMessages(messages) {
  return openDatabase().then(database => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      let writeCount = 0;
      
      if (messages.length === 0) {
        resolve(0);
        return;
      }

      messages.forEach(msg => {
        const getReq = store.get(msg.id);
        
        getReq.onsuccess = (e) => {
          const existing = e.target.result;
          if (existing) {
            if (existing.text === msg.text) {
              msg.embedding = existing.embedding;
              msg.processed = existing.processed;
            }
          }
          
          store.put(msg);
          writeCount++;
        };
        
        getReq.onerror = () => {
          store.put(msg);
          writeCount++;
        };
      });
      
      transaction.oncomplete = () => {
        resolve(writeCount);
      };
      
      transaction.onerror = (e) => {
        reject(e.target.error);
      };
    });
  });
}

function getPendingMessages(database, chatId) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('chatId');
    const request = index.getAll(chatId);
    
    request.onsuccess = (event) => {
      const all = event.target.result || [];
      const pending = all.filter(msg => msg.processed === 0 && msg.text && msg.text.trim().length > 0);
      resolve(pending);
    };
    
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function getEmbeddedMessages(database, chatId) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('chatId');
    const request = index.getAll(chatId);
    
    request.onsuccess = (event) => {
      const all = event.target.result || [];
      const embedded = all.filter(msg => msg.processed === 1 && msg.embedding);
      resolve(embedded);
    };
    
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function updateMessageEmbedding(database, id, embedding) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const getReq = store.get(id);
    getReq.onsuccess = (event) => {
      const msg = event.target.result;
      if (msg) {
        msg.embedding = embedding;
        msg.processed = 1;
        store.put(msg);
      }
    };
    
    transaction.oncomplete = () => {
      resolve();
    };
    
    transaction.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

function getIndexedCount(chatId) {
  return openDatabase().then(database => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME).index('chatId');
      const request = store.getAll(chatId);
      
      request.onsuccess = (event) => {
        const all = event.target.result || [];
        resolve({
          total: all.length,
          embedded: all.filter(msg => msg.processed === 1).length,
          pending: all.filter(msg => msg.processed === 0).length
        });
      };
      
      request.onerror = (e) => reject(e.target.error);
    });
  });
}

// ==========================================
// DATA RETENTION & DATABASE MANAGEMENT
// ==========================================

function clearChatData(chatId) {
  return openDatabase().then(database => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('chatId');
      const request = index.getAll(chatId);

      request.onsuccess = (event) => {
        const msgs = event.target.result || [];
        msgs.forEach(msg => store.delete(msg.id));
      };

      request.onerror = (e) => reject(e.target.error);

      transaction.oncomplete = () => {
        console.log(`Cleared all data for chat: ${chatId}`);
        resolve();
      };
      transaction.onerror = (e) => reject(e.target.error);
    });
  });
}

function clearAllDatabase() {
  return openDatabase().then(database => {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = (e) => reject(e.target.error);

      transaction.oncomplete = () => {
        console.log('Cleared entire SearchIt database.');
        resolve();
      };
      transaction.onerror = (e) => reject(e.target.error);
    });
  });
}

async function cleanupOldMessages() {
  const settings = await chrome.storage.local.get(['messageRetentionDays']);
  const retentionDays = parseInt(settings.messageRetentionDays || '0', 10);
  if (!retentionDays || retentionDays <= 0) return; // 0 = keep indefinitely

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    let deletedCount = 0;

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.timestamp && cursor.value.timestamp < cutoff) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      }
    };

    request.onerror = (e) => reject(e.target.error);

    transaction.oncomplete = () => {
      if (deletedCount > 0) {
        console.log(`Cleanup: deleted ${deletedCount} messages older than ${retentionDays} days.`);
      }
      resolve();
    };
    transaction.onerror = (e) => reject(e.target.error);
  });
}

// ==========================================
// BACKGROUND EMBEDDING GENERATION
// ==========================================

async function handleGetEmbedding(textInput, isBatch, configOverride = null) {
  const settings = configOverride || await chrome.storage.local.get([
    'apiKey',
    'apiProvider',
    'customUrl',
    'customModel'
  ]);

  const provider = settings.apiProvider || 'gemini';
  const apiKey = settings.apiKey || '';

  if (provider !== 'custom' && !apiKey) {
    throw new Error('API key is not configured. Please open Extension Settings to add your API key.');
  }

  const texts = isBatch ? textInput : [textInput];

  if (provider === 'gemini') {
    return await fetchGeminiEmbeddings(texts, apiKey);
  } else if (provider === 'openai') {
    return await fetchOpenAIEmbeddings(texts, apiKey, 'https://api.openai.com/v1/embeddings', settings.customModel || 'text-embedding-3-small');
  } else if (provider === 'custom') {
    const url = settings.customUrl || 'http://localhost:8000/v1/embeddings';
    const model = settings.customModel || 'gemini-embedding-2';
    return await fetchOpenAIEmbeddings(texts, apiKey, url, model);
  } else {
    throw new Error(`Unsupported API provider: ${provider}`);
  }
}

async function fetchGeminiEmbeddings(texts, apiKey) {
  if (texts.length === 1) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: {
            parts: [{ text: texts[0] }]
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    if (!json.embedding || !json.embedding.values) {
      throw new Error('Invalid embedding response from Gemini API.');
    }
    return [json.embedding.values];
  } else {
    const requests = texts.map(text => ({
      model: 'models/gemini-embedding-2',
      content: {
        parts: [{ text }]
      }
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requests })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini Batch API error (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    if (!json.embeddings) {
      throw new Error('Invalid batch embedding response from Gemini API.');
    }
    return json.embeddings.map(emb => emb.values);
  }
}

async function fetchOpenAIEmbeddings(texts, apiKey, endpointUrl, model) {
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: model,
      input: texts.length === 1 ? texts[0] : texts
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Proxy/OpenAI API error (${response.status}): ${errorText}`);
  }

  const json = await response.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error('Invalid embedding response structure from OpenAI/Proxy.');
  }

  const sortedData = [...json.data].sort((a, b) => (a.index || 0) - (b.index || 0));
  return sortedData.map(item => item.embedding);
}

// ==========================================
// BACKGROUND PROCESSING & VECTOR MATH
// ==========================================

async function processPendingEmbeddings(chatId) {
  const database = await openDatabase();
  const pending = await getPendingMessages(database, chatId);
  if (pending.length === 0) return;
  
  const batchSize = 30;
  
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const texts = batch.map(msg => msg.text);
    
    const embeddings = await handleGetEmbedding(texts, true);
    
    for (let j = 0; j < batch.length; j++) {
      await updateMessageEmbedding(database, batch[j].id, embeddings[j]);
    }
  }
}

function dotProduct(vecA, vecB) {
  let product = 0;
  const len = Math.min(vecA.length, vecB.length);
  for (let i = 0; i < len; i++) {
    product += vecA[i] * vecB[i];
  }
  return product;
}

function magnitude(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(vecA, vecB) {
  const magA = magnitude(vecA);
  const magB = magnitude(vecB);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(vecA, vecB) / (magA * magB);
}

async function performSemanticSearch(chatId, query) {
  const database = await openDatabase();
  
  // 1. Get embedding for the query
  const queryEmbeddings = await handleGetEmbedding(query, false);
  const queryEmbedding = queryEmbeddings[0];
  
  // 2. Load all embedded messages for this chat
  const embedded = await getEmbeddedMessages(database, chatId);
  if (embedded.length === 0) return [];
  
  // 3. Calculate similarity
  const results = embedded.map(msg => {
    const score = cosineSimilarity(queryEmbedding, msg.embedding);
    return {
      message: {
        id: msg.id,
        chatId: msg.chatId,
        sender: msg.sender,
        text: msg.text,
        timestamp: msg.timestamp
      },
      score: score
    };
  });
  
  // 4. Sort descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 15);
}
