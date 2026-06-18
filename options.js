// Options Page Script for WhatsApp Semantic Search Extension

document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('api-provider');
  const apiKeyInput = document.getElementById('api-key');
  const apikeyLabel = document.getElementById('apikey-label');
  const apikeyHelp = document.getElementById('apikey-help');
  const customUrlInput = document.getElementById('custom-url');
  const customModelInput = document.getElementById('custom-model');
  const endpointGroup = document.getElementById('endpoint-group');
  const modelGroup = document.getElementById('model-group');
  const providerHelp = document.getElementById('provider-help');
  
  const toggleKeyBtn = document.getElementById('toggle-key');
  const saveBtn = document.getElementById('save-btn');
  const btnSpinner = document.getElementById('btn-spinner');
  const btnText = document.getElementById('btn-text');
  const notification = document.getElementById('status-notification');
  const form = document.getElementById('settings-form');

  // Toggle API key visibility
  toggleKeyBtn.addEventListener('click', () => {
    const type = apiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
    apiKeyInput.setAttribute('type', type);
    
    // Toggle icon visual
    const path = toggleKeyBtn.querySelector('path');
    if (type === 'text') {
      // Eye-slash icon path
      path.setAttribute('d', 'M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88');
    } else {
      // Eye icon path
      path.setAttribute('d', 'M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z');
    }
  });

  // Handle provider changes
  providerSelect.addEventListener('change', () => {
    const provider = providerSelect.value;
    
    // Hide all conditional groups first
    endpointGroup.style.display = 'none';
    modelGroup.style.display = 'none';

    if (provider === 'gemini') {
      apikeyLabel.textContent = 'Gemini API Key';
      apikeyHelp.textContent = 'This key is saved locally in your browser and is only sent to Google APIs.';
      apiKeyInput.placeholder = 'Enter your Gemini API key';
      providerHelp.innerHTML = 'Uses Google\'s gemini-embedding-2 model. Get a free API key from <a href="https://aistudio.google.com/" target="_blank">Google AI Studio</a>.';
    } else if (provider === 'openai') {
      apikeyLabel.textContent = 'OpenAI API Key';
      apikeyHelp.textContent = 'This key is saved locally in your browser and is only sent to OpenAI APIs.';
      apiKeyInput.placeholder = 'sk-...';
      providerHelp.innerHTML = 'Uses OpenAI\'s embedding model. Get an API key from the <a href="https://platform.openai.com/api-keys" target="_blank">OpenAI Developer Platform</a>.';
      modelGroup.style.display = 'flex';
      customModelInput.placeholder = 'text-embedding-3-small';
    } else if (provider === 'custom') {
      apikeyLabel.textContent = 'Proxy API Key (Optional)';
      apikeyHelp.textContent = 'Enter an API key if required by your custom proxy server.';
      apiKeyInput.placeholder = 'Enter proxy key if needed';
      providerHelp.innerHTML = 'Route requests through a custom API wrapper (e.g., CLIProxyAPI or local Gemini-API).';
      endpointGroup.style.display = 'flex';
      modelGroup.style.display = 'flex';
      customUrlInput.placeholder = 'http://localhost:8000/v1/embeddings';
      customModelInput.placeholder = 'gemini-embedding-2';
    }
  });

  // Load existing settings
  chrome.storage.local.get([
    'apiProvider',
    'apiKey',
    'customUrl',
    'customModel'
  ], (items) => {
    if (items.apiProvider) {
      providerSelect.value = items.apiProvider;
    }
    apiKeyInput.value = items.apiKey || atob('QVEuQWI4Uk42TGN4UWtjVVpscnlBaUc1bGpheDM2NDlXRkNxdXg3amdFVHdfc3FWRVlTTkE=');
    if (items.customUrl) {
      customUrlInput.value = items.customUrl;
    }
    if (items.customModel) {
      customModelInput.value = items.customModel;
    }
    
    // Trigger change event to set correct initial visibility
    providerSelect.dispatchEvent(new Event('change'));
  });

  // Handle form submission and validation
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideNotification();
    setLoading(true);

    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const customUrl = customUrlInput.value.trim();
    const customModel = customModelInput.value.trim();

    // Basic validation
    if (provider !== 'custom' && !apiKey) {
      showNotification('Please enter your API Key to verify.', 'error');
      setLoading(false);
      return;
    }
    if (provider === 'custom' && !customUrl) {
      showNotification('Please enter the Custom Endpoint URL.', 'error');
      setLoading(false);
      return;
    }

    // Save configuration temporarily to storage so the background script can use it for verification
    const configToTest = {
      apiProvider: provider,
      apiKey: apiKey,
      customUrl: customUrl || undefined,
      customModel: customModel || undefined
    };

    try {
      // Write temporarily to local storage
      await chrome.storage.local.set(configToTest);

      // Request a test embedding from background.js
      chrome.runtime.sendMessage(
        { action: 'getEmbedding', text: 'Verification test message for semantic search extension', isBatch: false },
        (response) => {
          setLoading(false);
          
          if (response && response.success) {
            showNotification('Settings verified & saved successfully! You can now close this tab and start searching on WhatsApp Web.', 'success');
          } else {
            const errorMsg = (response && response.error) ? response.error : 'Unknown API response error';
            showNotification(`Verification Failed: ${errorMsg}. Please double-check your API Key, Model name, or Endpoint URL and try again.`, 'error');
          }
        }
      );
    } catch (err) {
      setLoading(false);
      showNotification(`System Error: ${err.message}`, 'error');
    }
  });

  function setLoading(isLoading) {
    if (isLoading) {
      saveBtn.disabled = true;
      btnSpinner.style.display = 'inline-block';
      btnText.textContent = 'Verifying Connection...';
    } else {
      saveBtn.disabled = false;
      btnSpinner.style.display = 'none';
      btnText.textContent = 'Verify & Save Settings';
    }
  }

  function showNotification(message, type) {
    notification.textContent = message;
    notification.className = `notification notification-${type}`;
    notification.style.display = 'block';
  }

  function hideNotification() {
    notification.style.display = 'none';
  }
});
