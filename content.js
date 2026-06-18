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
      
      let day = p1;
      let month = p2 - 1;
      
      if (p1 > 12) {
        day = p1;
        month = p2 - 1;
      } else if (p2 > 12) {
        day = p2;
        month = p1 - 1;
      } else {
        day = p1;
        month = p2 - 1;
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
      sender = isOut ? 'Me' : chatId;
      
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
        <button class="wss-btn wss-btn-primary" id="wss-scan-btn">Scan Chat History</button>
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
    
    resultsContainer.innerHTML = `
      <div class="wss-results-placeholder" style="color:#fca5a5">
        Failed to scan: ${err.message}. <br/><br/>
        Please check if your <a href="#" id="wss-err-settings" class="wss-settings-link">Extension Settings</a> are verified.
      </div>
    `;
    
    const settingsLink = document.getElementById('wss-err-settings');
    if (settingsLink) {
      settingsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ action: 'openOptions' });
      });
    }
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
      locateBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" width="14" height="14">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25s-7.5-4.108-7.5-11.25g3 3 0 1 1 15 10.5Z" />
        </svg>
        Locate
      `;
      
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
    resultsContainer.innerHTML = `
      <div class="wss-results-placeholder" style="color:#fca5a5">
        Search failed: ${err.message}. <br/><br/>
        Please check if your <a href="#" id="wss-search-err-settings" class="wss-settings-link">Extension Settings</a> are configured correctly.
      </div>
    `;
    
    const settingsLink = document.getElementById('wss-search-err-settings');
    if (settingsLink) {
      settingsLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ action: 'openOptions' });
      });
    }
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
      sender = isOut ? 'Me' : chatId;
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
