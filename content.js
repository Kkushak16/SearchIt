// Content Script for WhatsApp Semantic Search Extension

let currentChatId = null;
let isScanning = false;
let activeObserver = null;

// Initialize when page is loaded
init();

function init() {
  console.log('WhatsApp Semantic Search extension initializing in secure isolated mode...');
  injectUI();
  setupPolling();
  setupClickListeners();
}

// ==========================================
// BACKGROUND BRIDGE DATABASE ACTIONS
// ==========================================

function storeMessages(messages) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'storeMessages', messages }, (response) => {
      if (response && response.success) {
        resolve(response.count);
      } else {
        reject(new Error(response ? response.error : 'Failed to store messages in background database'));
      }
    });
  });
}

// Fetch indexed message count for active chat
function getIndexedCount(chatId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'getIndexedCount', chatId }, (response) => {
      if (response && response.success) {
        resolve(response.counts);
      } else {
        reject(new Error(response ? response.error : 'Failed to read indexed counts from background'));
      }
    });
  });
}

function triggerPendingEmbeddings(chatId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'processEmbeddings', chatId }, (response) => {
      if (response && response.success) {
        resolve();
      } else {
        reject(new Error(response ? response.error : 'Embedding batch processing failed in background'));
      }
    });
  });
}

function performSemanticSearch(chatId, query) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'performSearch', chatId, query }, (response) => {
      if (response && response.success) {
        resolve(response.results);
      } else {
        reject(new Error(response ? response.error : 'Search query failed in background'));
      }
    });
  });
}


// ==========================================
// WHATSAPP DOM PARSING & UTILITIES
// ==========================================

// Find scrollable parent dynamically by traversing up from any message bubble
function findScrollContainer() {
  const bubble = document.querySelector('div[data-id], .copyable-text, [class*="message-in"], [class*="message-out"]');
  if (!bubble) return null;
  
  let parent = bubble.parentElement;
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent);
    const overflowY = style.getPropertyValue('overflow-y');
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
      return parent;
    }
    parent = parent.parentElement;
  }
  
  // Layout fallback
  const roleRegion = document.querySelector('div[role="region"]');
  if (roleRegion) {
    const scrollable = roleRegion.querySelector('div[style*="overflow-y: scroll"], div[style*="overflow-y: auto"]');
    if (scrollable) return scrollable;
  }
  
  return null;
}

// Robustly find the active chat header
function findActiveChatHeader() {
  // 1. Core relationship: The active chat header is a sibling/parent of the scrollable message window
  const scrollContainer = findScrollContainer();
  if (scrollContainer) {
    let parent = scrollContainer.parentElement;
    // Walk up up to 3 levels to locate the main conversation pane container
    for (let i = 0; i < 4; i++) {
      if (!parent || parent === document.body) break;
      const header = parent.querySelector('header');
      if (header) {
        return header;
      }
      parent = parent.parentElement;
    }
  }
  
  // 2. Coordinate fallback: If there are multiple headers, return the one on the right (chat view)
  const headers = document.querySelectorAll('header');
  if (headers.length === 1) {
    // If only one header exists on screen and message bubbles are loaded, this is the active chat
    if (document.querySelector('div[data-id]')) {
      return headers[0];
    }
  } else if (headers.length > 1) {
    for (const header of headers) {
      const rect = header.getBoundingClientRect();
      if (rect.left > 200) {
        return header;
      }
    }
    return headers[1]; // Return second header in DOM order as a default fallback
  }
  
  return null;
}

function getActiveChatName() {
  const header = findActiveChatHeader();
  if (!header) return null;
  
  // Pass 1: Look for title spans that represent names (filter out buttons)
  const spans = header.querySelectorAll('span[title]');
  for (const span of spans) {
    const title = span.getAttribute('title');
    if (title && title.trim()) {
      const lowerTitle = title.toLowerCase().trim();
      const ignored = ['search', 'menu', 'more options', 'voice call', 'video call', 'attach', 'profile', 'status', 'mute', 'filter', 'info'];
      if (!ignored.some(word => lowerTitle.includes(word))) {
        return title.trim();
      }
    }
  }
  
  // Pass 2: Fallback to any div/span with dir="auto" (common for bi-directional text in contact headers)
  // Filtering out status descriptions like "online", "typing..."
  const dirAutoEls = header.querySelectorAll('[dir="auto"]');
  for (const el of dirAutoEls) {
    const text = el.innerText || el.textContent || '';
    if (text && text.trim()) {
      const lowerText = text.toLowerCase().trim();
      const ignored = ['search', 'menu', 'more options', 'voice call', 'video call', 'online', 'typing...', 'last seen', 'click here', 'info'];
      if (!ignored.some(word => lowerText.includes(word))) {
        return text.trim();
      }
    }
  }
  
  return null;
}

// Detect whether system locale formats dates as MM/DD/YYYY (US) vs DD/MM/YYYY (EU/rest)
function isMonthFirstLocale() {
  try {
    // Format a known date (Dec 25) and check if month (12) or day (25) appears first
    const testDate = new Date(2000, 11, 25); // Dec 25, 2000
    const formatted = testDate.toLocaleDateString();
    const parts = formatted.split(/[^0-9]/).filter(Boolean);
    // If the first numeric group is 12, month comes first (US)
    // If it is 25, day comes first (EU)
    return parseInt(parts[0], 10) === 12;
  } catch (e) {
    return false; // Default to EU day-first
  }
}

function parseWhatsAppDate(dateStr) {
  try {
    const parts = dateStr.split(',');
    if (parts.length < 2) return Date.now();
    
    const timePart = parts[0].trim();
    const datePart = parts[1].trim();
    
    let hours = 0, minutes = 0;
    const timeMatch = timePart.match(/(\d+):(\d+)(?:\s*(AM|PM))?/i);
    if (timeMatch) {
      hours = parseInt(timeMatch[1], 10);
      minutes = parseInt(timeMatch[2], 10);
      const ampm = timeMatch[3];
      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
        if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
      }
    }
    
    const dateMatch = datePart.match(/(\d+)\/(\d+)\/(\d+)/);
    if (dateMatch) {
      const p1 = parseInt(dateMatch[1], 10);
      const p2 = parseInt(dateMatch[2], 10);
      const year = parseInt(dateMatch[3], 10);
      
      let day, month;

      if (p1 > 12) {
        // Unambiguous: first part must be day
        day = p1; month = p2 - 1;
      } else if (p2 > 12) {
        // Unambiguous: second part must be day
        day = p2; month = p1 - 1;
      } else {
        // Ambiguous — use locale heuristic
        if (isMonthFirstLocale()) {
          month = p1 - 1; day = p2; // US: MM/DD/YYYY
        } else {
          day = p1; month = p2 - 1; // EU: DD/MM/YYYY
        }
      }
      
      return new Date(year, month, day, hours, minutes).getTime();
    }
  } catch (e) {
    console.error('Failed to parse date:', dateStr, e);
  }
  return Date.now();
}

function scrapeVisibleMessages(chatId) {
  const messages = [];
  const messageElements = document.querySelectorAll('div[data-id]');
  
  messageElements.forEach(msgEl => {
    const id = msgEl.getAttribute('data-id');
    const textEl = msgEl.querySelector('.selectable-text');
    
    if (!id || !textEl) return;
    
    const text = textEl.innerText || textEl.textContent || '';
    if (!text.trim()) return;
    
    let sender = 'Me';
    let timestamp = Date.now();
    
    const copyableEl = msgEl.querySelector('.copyable-text');
    if (copyableEl) {
      const preText = copyableEl.getAttribute('data-pre-plain-text');
      if (preText) {
        const match = preText.match(/\[(.*?)\]\s*(.*?):/);
        if (match) {
          timestamp = parseWhatsAppDate(match[1]);
          sender = match[2].trim();
        }
      }
    } else {
      const isOut = msgEl.classList.contains('message-out') || msgEl.querySelector('.message-out');
      if (isOut) {
        sender = 'Me';
      } else {
        // Group chat: try to extract individual sender name from colored span
        const colorSpan = msgEl.querySelector('span[style*="color"], span[class*="color-"]');
        sender = (colorSpan && colorSpan.textContent.trim()) ? colorSpan.textContent.trim() : chatId;
      }
      
      const timeEl = msgEl.querySelector('span[style*="font-size"]');
      if (timeEl) {
        timestamp = parseWhatsAppDate(`${timeEl.innerText || '12:00'}, ${new Date().toLocaleDateString()}`);
      }
    }
    
    messages.push({
      id,
      chatId,
      sender,
      text,
      timestamp,
      processed: 0
    });
  });
  
  return messages;
}

// ==========================================
// SCROLL AND AUTO-INDEXING CONTROLLER
// ==========================================

async function runChatScan(chatId, onProgress) {
  const container = findScrollContainer();
  if (!container) {
    throw new Error('Could not find scroll container. Ensure a chat is open.');
  }
  
  isScanning = true;
  let scrollStep = 0;
  const maxScrollSteps = 30;
  let lastScrollTop = container.scrollTop;
  let noChangeCount = 0;
  const originalScrollTop = container.scrollTop;
  
  while (isScanning && scrollStep < maxScrollSteps) {
    const scraped = scrapeVisibleMessages(chatId);
    if (scraped.length > 0) {
      await storeMessages(scraped);
    }
    
    const count = await getIndexedCount(chatId);
    onProgress({
      step: scrollStep + 1,
      maxSteps: maxScrollSteps,
      scrapedCount: count.total
    });
    
    container.scrollTop = Math.max(0, container.scrollTop - 800);
    scrollStep++;
    
    await new Promise(resolve => setTimeout(resolve, 900));
    
    if (container.scrollTop === lastScrollTop) {
      noChangeCount++;
      if (noChangeCount >= 2 || container.scrollTop === 0) {
        break;
      }
    } else {
      noChangeCount = 0;
    }
    lastScrollTop = container.scrollTop;
  }
  
  const finalScraped = scrapeVisibleMessages(chatId);
  if (finalScraped.length > 0) {
    await storeMessages(finalScraped);
  }
  
  isScanning = false;
  container.scrollTop = originalScrollTop;
  
  return await getIndexedCount(chatId);
}

// ==========================================
// SEEK & LOCATE IN NATIVE UI
// ==========================================

async function locateMessage(id) {
  let element = document.querySelector(`div[data-id="${id}"]`);
  
  if (element) {
    scrollToAndHighlight(element);
    return true;
  }
  
  const container = findScrollContainer();
  if (!container) return false;
  
  const originalScrollTop = container.scrollTop;
  let seekStep = 0;
  const maxSeeks = 15;
  
  while (seekStep < maxSeeks) {
    container.scrollTop = Math.max(0, container.scrollTop - 900);
    seekStep++;
    
    await new Promise(resolve => setTimeout(resolve, 350));
    
    element = document.querySelector(`div[data-id="${id}"]`);
    if (element) {
      scrollToAndHighlight(element);
      return true;
    }
    
    if (container.scrollTop === 0) {
      break;
    }
  }
  
  container.scrollTop = originalScrollTop;
  seekStep = 0;
  
  while (seekStep < maxSeeks) {
    container.scrollTop = Math.min(container.scrollHeight, container.scrollTop + 900);
    seekStep++;
    
    await new Promise(resolve => setTimeout(resolve, 350));
    
    element = document.querySelector(`div[data-id="${id}"]`);
    if (element) {
      scrollToAndHighlight(element);
      return true;
    }
    
    if (container.scrollTop + container.clientHeight >= container.scrollHeight) {
      break;
    }
  }
  
  container.scrollTop = originalScrollTop;
  return false;
}

function scrollToAndHighlight(element) {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('wss-highlight-flash');
  setTimeout(() => {
    element.classList.remove('wss-highlight-flash');
  }, 2500);
}

// ==========================================
// EXTENSION UI RENDERING
// ==========================================

function injectUI() {
  if (document.querySelector('.wss-toggle-btn')) return;
  
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'wss-toggle-btn';
  toggleBtn.title = 'Open Semantic Search Panel';
  toggleBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
    </svg>
  `;
  
  const sidebar = document.createElement('div');
  sidebar.className = 'wss-sidebar';
  sidebar.innerHTML = `
    <div class="wss-header">
      <h3 class="wss-header-title">Semantic Search</h3>
      <button class="wss-close-btn" id="wss-close">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="18" height="18">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div class="wss-body">
      <div class="wss-card">
        <div class="wss-card-title" id="wss-chat-title">Current Chat: None</div>
        <div class="wss-index-status">
          <span>Indexed Messages:</span>
          <span class="wss-status-badge ready" id="wss-indexed-count">0</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="wss-btn wss-btn-primary" id="wss-scan-btn" style="flex:1">Scan Chat History</button>
          <button class="wss-btn" id="wss-clear-chat-btn" title="Clear indexed data for this chat" style="flex:0 0 auto;width:auto;padding:10px 12px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.25);color:#fca5a5;font-size:0.8rem;">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="14" height="14">
              <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          </button>
        </div>
      </div>
      
      <div class="wss-card">
        <div class="wss-card-title">Concept Search</div>
        <div class="wss-search-wrapper">
          <input type="text" class="wss-search-input" id="wss-search-input" placeholder="Search logic/concept..." disabled>
          <span class="wss-search-icon">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="18" height="18">
              <path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.602 10.602Z" />
            </svg>
          </span>
        </div>
      </div>
      
      <div class="wss-results-container" id="wss-results">
        <div class="wss-results-placeholder">Select a chat and click "Scan Chat History" to start semantic search.</div>
      </div>
    </div>
  `;
  
  document.body.appendChild(toggleBtn);
  document.body.appendChild(sidebar);
  
  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open')) {
      updateUIState();
    }
  });
  
  sidebar.querySelector('#wss-close').addEventListener('click', () => {
    sidebar.classList.remove('open');
  });
  
  const scanBtn = sidebar.querySelector('#wss-scan-btn');
  scanBtn.addEventListener('click', handleScanTrigger);

  // Clear Chat button
  sidebar.querySelector('#wss-clear-chat-btn').addEventListener('click', () => {
    if (!currentChatId) return;
    if (!confirm(`Clear all indexed data for "${currentChatId}"? This cannot be undone.`)) return;
    chrome.runtime.sendMessage({ action: 'clearChatData', chatId: currentChatId }, (response) => {
      if (response && response.success) {
        document.getElementById('wss-indexed-count').textContent = '0';
        const searchInput = document.getElementById('wss-search-input');
        searchInput.disabled = true;
        searchInput.value = '';
        const results = document.getElementById('wss-results');
        results.innerHTML = '';
        const placeholder = document.createElement('div');
        placeholder.className = 'wss-results-placeholder';
        placeholder.textContent = 'Chat data cleared. Scan again to re-index.';
        results.appendChild(placeholder);
      } else {
        const msg = response && response.error ? response.error : 'Unknown error';
        alert('Failed to clear chat: ' + msg);
      }
    });
  });
  
  const searchInput = sidebar.querySelector('#wss-search-input');
  searchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const query = searchInput.value.trim();
      if (!query) return;
      
      handleSearch(query);
    }
  });
}

function updateUIState() {
  const chatTitle = document.getElementById('wss-chat-title');
  const indexedCount = document.getElementById('wss-indexed-count');
  const searchInput = document.getElementById('wss-search-input');
  const scanBtn = document.getElementById('wss-scan-btn');

  if (!currentChatId) {
    chatTitle.textContent = 'Current Chat: None';
    indexedCount.textContent = '0';
    searchInput.disabled = true;
    scanBtn.disabled = true;
    return;
  }

  chatTitle.textContent = `Current Chat: ${currentChatId}`;
  scanBtn.disabled = false;

  getIndexedCount(currentChatId).then(count => {
    indexedCount.textContent = `${count.embedded} (${count.total} loaded)`;
    searchInput.disabled = count.embedded === 0;
    if (count.embedded === 0) {
      searchInput.placeholder = 'Scan chat history first to search...';
    } else {
      searchInput.placeholder = 'Search logic/concept...';
    }
  }).catch(err => {
    console.error('Error updating UI state counts:', err);
  });
}

async function handleScanTrigger() {
  const scanBtn = document.getElementById('wss-scan-btn');
  const searchInput = document.getElementById('wss-search-input');
  const indexedCount = document.getElementById('wss-indexed-count');
  const resultsContainer = document.getElementById('wss-results');
  
  if (isScanning) {
    isScanning = false;
    scanBtn.textContent = 'Stopping...';
    return;
  }
  
  scanBtn.innerHTML = '<span class="wss-spinner"></span> Scanning Chat... (Click to Stop)';
  scanBtn.className = 'wss-btn wss-btn-secondary';
  searchInput.disabled = true;
  resultsContainer.innerHTML = '<div class="wss-results-placeholder">Scrolling and capturing messages...</div>';
  
  try {
    const finalCounts = await runChatScan(currentChatId, (progress) => {
      indexedCount.textContent = `${progress.scrapedCount} loaded`;
    });
    
    scanBtn.innerHTML = '<span class="wss-spinner"></span> Generating Vectors...';
    resultsContainer.innerHTML = `<div class="wss-results-placeholder">Calculating embeddings for pending messages in background...</div>`;
    
    await triggerPendingEmbeddings(currentChatId);
    
    const count = await getIndexedCount(currentChatId);
    indexedCount.textContent = `${count.embedded} (${count.total} loaded)`;
    resultsContainer.innerHTML = `<div class="wss-results-placeholder">Indexing finished! ${count.embedded} messages are ready for semantic search.</div>`;
    
    scanBtn.textContent = 'Scan Chat History';
    scanBtn.className = 'wss-btn wss-btn-primary';
    searchInput.disabled = false;
    searchInput.placeholder = 'Search logic/concept...';
    
    setupLiveObserver();
  } catch (err) {
    console.error(err);
    scanBtn.textContent = 'Scan Chat History';
    scanBtn.className = 'wss-btn wss-btn-primary';
    updateUIState();
    resultsContainer.innerHTML = '';
    const errorDiv = document.createElement('div');
    errorDiv.className = 'wss-results-placeholder';
    errorDiv.style.color = '#fca5a5';
    errorDiv.appendChild(document.createTextNode(`Failed to scan: ${err.message}. `));
    errorDiv.appendChild(document.createElement('br'));
    errorDiv.appendChild(document.createElement('br'));
    errorDiv.appendChild(document.createTextNode('Please check if your '));
    const settingsLink = document.createElement('a');
    settingsLink.href = '#';
    settingsLink.id = 'wss-err-settings';
    settingsLink.className = 'wss-settings-link';
    settingsLink.textContent = 'Extension Settings';
    settingsLink.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.sendMessage({ action: 'openOptions' }); });
    errorDiv.appendChild(settingsLink);
    errorDiv.appendChild(document.createTextNode(' are verified.'));
    resultsContainer.appendChild(errorDiv);
  }
}

async function handleSearch(query) {
  const resultsContainer = document.getElementById('wss-results');
  resultsContainer.innerHTML = '<div class="wss-results-placeholder"><span class="wss-spinner" style="display:inline-block"></span> Searching database...</div>';
  
  try {
    const results = await performSemanticSearch(currentChatId, query);
    
    if (results.length === 0) {
      resultsContainer.innerHTML = '<div class="wss-results-placeholder">No matching messages found. Make sure you have scanned the chat first.</div>';
      return;
    }
    
    resultsContainer.innerHTML = '';
    
    results.forEach(res => {
      const msg = res.message;
      const scorePercentage = Math.round(res.score * 100);
      
      if (scorePercentage < 35) return;
      
      const card = document.createElement('div');
      card.className = 'wss-result-card';
      
      const isHigh = scorePercentage >= 75;
      const badgeClass = isHigh ? 'wss-score-badge wss-score-high' : 'wss-score-badge wss-score-med';
      
      const date = new Date(msg.timestamp);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      
      // Create Result Header
      const headerDiv = document.createElement('div');
      headerDiv.className = 'wss-result-header';
      
      const senderSpan = document.createElement('span');
      senderSpan.className = 'wss-result-sender';
      senderSpan.textContent = msg.sender;
      
      const badgeSpan = document.createElement('span');
      badgeSpan.className = badgeClass;
      badgeSpan.textContent = `${scorePercentage}% match`;
      
      headerDiv.appendChild(senderSpan);
      headerDiv.appendChild(badgeSpan);
      
      // Create Result Text
      const textDiv = document.createElement('div');
      textDiv.className = 'wss-result-text';
      textDiv.textContent = msg.text;
      
      // Create Result Footer
      const footerDiv = document.createElement('div');
      footerDiv.className = 'wss-result-footer';
      
      const timeSpan = document.createElement('span');
      timeSpan.className = 'wss-result-time';
      timeSpan.textContent = timeStr;
      
      const locateBtn = document.createElement('button');
      locateBtn.className = 'wss-locate-btn';
      locateBtn.setAttribute('data-msg-id', msg.id);

      // Map-pin SVG (Heroicons outline) — correct paths
      const locateSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      locateSvg.setAttribute('fill', 'none');
      locateSvg.setAttribute('viewBox', '0 0 24 24');
      locateSvg.setAttribute('stroke-width', '2.5');
      locateSvg.setAttribute('stroke', 'currentColor');
      locateSvg.setAttribute('width', '14');
      locateSvg.setAttribute('height', '14');
      const pinCircle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pinCircle.setAttribute('stroke-linecap', 'round');
      pinCircle.setAttribute('stroke-linejoin', 'round');
      pinCircle.setAttribute('d', 'M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z');
      const pinBody = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pinBody.setAttribute('stroke-linecap', 'round');
      pinBody.setAttribute('stroke-linejoin', 'round');
      pinBody.setAttribute('d', 'M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z');
      locateSvg.appendChild(pinCircle);
      locateSvg.appendChild(pinBody);
      locateBtn.appendChild(locateSvg);
      locateBtn.appendChild(document.createTextNode(' Locate'));
      
      locateBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const origContent = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="wss-spinner" style="width:12px;height:12px"></span> Seeking';
        
        const success = await locateMessage(msg.id);
        btn.disabled = false;
        btn.innerHTML = origContent;
        
        if (!success) {
          alert('Message is older and currently not loaded in view. Scroll upwards to load historical messages, and click Locate again.');
        }
      });
      
      footerDiv.appendChild(timeSpan);
      footerDiv.appendChild(locateBtn);
      
      card.appendChild(headerDiv);
      card.appendChild(textDiv);
      card.appendChild(footerDiv);
      
      resultsContainer.appendChild(card);
    });
    
    if (resultsContainer.children.length === 0) {
      resultsContainer.innerHTML = '<div class="wss-results-placeholder">No highly relevant messages found (relevance above 35%).</div>';
    }
  } catch (err) {
    console.error(err);
    resultsContainer.innerHTML = '';
    const errorDiv = document.createElement('div');
    errorDiv.className = 'wss-results-placeholder';
    errorDiv.style.color = '#fca5a5';
    errorDiv.appendChild(document.createTextNode(`Search failed: ${err.message}. `));
    errorDiv.appendChild(document.createElement('br'));
    errorDiv.appendChild(document.createElement('br'));
    errorDiv.appendChild(document.createTextNode('Please check if your '));
    const settingsLink = document.createElement('a');
    settingsLink.href = '#';
    settingsLink.id = 'wss-search-err-settings';
    settingsLink.className = 'wss-settings-link';
    settingsLink.textContent = 'Extension Settings';
    settingsLink.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.sendMessage({ action: 'openOptions' }); });
    errorDiv.appendChild(settingsLink);
    errorDiv.appendChild(document.createTextNode(' are configured correctly.'));
    resultsContainer.appendChild(errorDiv);
  }
}

// ==========================================
// ACTIVE CHAT MONITOR & LIVE UPDATE SERVICES
// ==========================================

function resetSearchResults() {
  const resultsContainer = document.getElementById('wss-results');
  if (resultsContainer) {
    resultsContainer.innerHTML = currentChatId 
      ? '<div class="wss-results-placeholder">Ready to search. Hit Scan to capture any older history.</div>'
      : '<div class="wss-results-placeholder">Open a chat to begin.</div>';
  }
  const searchInput = document.getElementById('wss-search-input');
  if (searchInput) {
    searchInput.value = '';
  }
}

function setupPolling() {
  setInterval(() => {
    const activeChat = getActiveChatName();
    if (activeChat !== currentChatId) {
      currentChatId = activeChat;
      console.log('Active WhatsApp Chat changed (polling) to:', currentChatId);
      updateUIState();
      resetSearchResults();
      setupLiveObserver();
    }
  }, 1500);
}

function setupClickListeners() {
  // Listen for clicks inside WhatsApp elements to switch active chat faster
  document.addEventListener('click', () => {
    // Small timeout to allow DOM changes to settle
    setTimeout(() => {
      const activeChat = getActiveChatName();
      if (activeChat !== currentChatId) {
        currentChatId = activeChat;
        console.log('Active WhatsApp Chat changed (click listener) to:', currentChatId);
        updateUIState();
        resetSearchResults();
        setupLiveObserver();
      }
    }, 350);
  });
}

function setupLiveObserver() {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }
  
  if (!currentChatId) return;
  
  const container = findScrollContainer();
  if (!container) return;
  
  console.log('Setting up live mutation observer for chat container.');
  
  activeObserver = new MutationObserver((mutations) => {
    let addedElements = [];
    
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.hasAttribute('data-id')) {
            addedElements.push(node);
          } else {
            const children = node.querySelectorAll('div[data-id]');
            children.forEach(c => addedElements.push(c));
          }
        }
      });
    });
    
    if (addedElements.length > 0) {
      handleLiveMessages(addedElements);
    }
  });
  
  activeObserver.observe(container, { childList: true, subtree: true });
}

async function handleLiveMessages(elements) {
  const chatId = currentChatId;
  const messagesToStore = [];
  
  elements.forEach(msgEl => {
    const id = msgEl.getAttribute('data-id');
    const textEl = msgEl.querySelector('.selectable-text');
    
    if (!id || !textEl) return;
    
    const text = textEl.innerText || textEl.textContent || '';
    if (!text.trim()) return;
    
    let sender = 'Me';
    let timestamp = Date.now();
    
    const copyableEl = msgEl.querySelector('.copyable-text');
    if (copyableEl) {
      const preText = copyableEl.getAttribute('data-pre-plain-text');
      if (preText) {
        const match = preText.match(/\[(.*?)\]\s*(.*?):/);
        if (match) {
          timestamp = parseWhatsAppDate(match[1]);
          sender = match[2].trim();
        }
      }
    } else {
      const isOut = msgEl.classList.contains('message-out') || msgEl.querySelector('.message-out');
      if (isOut) {
        sender = 'Me';
      } else {
        // Group chat: try to extract individual sender name from colored span
        const colorSpan = msgEl.querySelector('span[style*="color"], span[class*="color-"]');
        sender = (colorSpan && colorSpan.textContent.trim()) ? colorSpan.textContent.trim() : chatId;
      }
    }
    
    messagesToStore.push({
      id,
      chatId,
      sender,
      text,
      timestamp,
      processed: 0
    });
  });
  
  if (messagesToStore.length === 0) return;
  
  try {
    await storeMessages(messagesToStore);
    
    const settings = await chrome.storage.local.get(['apiKey', 'apiProvider']);
    const provider = settings.apiProvider || 'gemini';
    const apiKey = settings.apiKey;
    
    if (apiKey || provider === 'custom') {
      await triggerPendingEmbeddings(chatId);
      updateUIState();
    }
  } catch (e) {
    console.error('Error auto-indexing live messages:', e);
  }
}

// Helper: Escape HTML
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}
