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
  const retentionSelect = document.getElementById('retention-days');
  const clearDbBtn = document.getElementById('clear-db-btn');

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

  // Track the API config that was loaded from storage (= already verified)
  let lastVerifiedConfig = null;

  // Load existing settings
  chrome.storage.local.get([
    'apiProvider',
    'apiKey',
    'customUrl',
    'customModel',
    'messageRetentionDays'
  ], (items) => {
    if (items.apiProvider) {
      providerSelect.value = items.apiProvider;
    }
    apiKeyInput.value = items.apiKey || '';
    if (items.customUrl) {
      customUrlInput.value = items.customUrl;
    }
    if (items.customModel) {
      customModelInput.value = items.customModel;
    }
    if (items.messageRetentionDays !== undefined) {
      retentionSelect.value = String(items.messageRetentionDays);
    }

    // Snapshot what was loaded — these settings are already verified
    lastVerifiedConfig = {
      apiProvider: items.apiProvider || 'gemini',
      apiKey: items.apiKey || '',
      customUrl: items.customUrl || '',
      customModel: items.customModel || ''
    };

    // Trigger change event to set correct initial visibility
    providerSelect.dispatchEvent(new Event('change'));

    // If a key is already saved, reflect that in the button
    if (items.apiKey || items.apiProvider === 'custom') {
      btnText.textContent = 'Save Settings';
    }
  });

  // Update button label whenever API-critical fields change
  function onApiFieldChange() {
    if (!lastVerifiedConfig) return;
    btnText.textContent = apiConfigChanged() ? 'Verify & Save Settings' : 'Save Settings';
  }
  providerSelect.addEventListener('change', onApiFieldChange);
  apiKeyInput.addEventListener('input', onApiFieldChange);
  customUrlInput.addEventListener('input', onApiFieldChange);
  customModelInput.addEventListener('input', onApiFieldChange);

  // Clear all database button
  clearDbBtn.addEventListener('click', () => {
    if (!confirm('Are you sure you want to permanently delete ALL indexed messages and embeddings? This cannot be undone.')) return;
    clearDbBtn.disabled = true;
    clearDbBtn.textContent = 'Clearing...';
    chrome.runtime.sendMessage({ action: 'clearAllDatabase' }, (response) => {
      clearDbBtn.disabled = false;
      clearDbBtn.textContent = 'Clear All Indexed Chat Database';
      if (response && response.success) {
        showNotification('All indexed chat data has been permanently deleted.', 'success');
      } else {
        const msg = (response && response.error) ? response.error : 'Unknown error';
        showNotification('Failed to clear database: ' + msg, 'error');
      }
    });
  });

  // Returns true if the current form values differ from the last verified config
  function apiConfigChanged() {
    if (!lastVerifiedConfig) return true;
    return (
      providerSelect.value !== lastVerifiedConfig.apiProvider ||
      apiKeyInput.value.trim() !== lastVerifiedConfig.apiKey ||
      customUrlInput.value.trim() !== lastVerifiedConfig.customUrl ||
      customModelInput.value.trim() !== lastVerifiedConfig.customModel
    );
  }

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

    const retentionDays = retentionSelect ? parseInt(retentionSelect.value || '0', 10) : 0;

    // Save non-API settings only (no API call needed)
    const quickSave = async () => {
      const config = {
        apiProvider: provider,
        apiKey: apiKey,
        customUrl: customUrl || undefined,
        customModel: customModel || undefined,
        messageRetentionDays: retentionDays
      };
      try {
        await chrome.storage.local.set(config);
        setLoading(false);
        showNotification('Settings saved.', 'success');
      } catch (err) {
        setLoading(false);
        showNotification(`Save error: ${err.message}`, 'error');
      }
    };

    const verifyAndSave = async () => {
      const configToTest = {
        apiProvider: provider,
        apiKey: apiKey,
        customUrl: customUrl || undefined,
        customModel: customModel || undefined,
        messageRetentionDays: retentionDays
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
              // Update snapshot so subsequent saves skip verification
              lastVerifiedConfig = { apiProvider: provider, apiKey, customUrl, customModel };
              btnText.textContent = 'Save Settings';
              showNotification('Settings verified & saved! You can now close this tab and start searching on WhatsApp Web.', 'success');
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
    };

    // Skip verification entirely if API config hasn't changed
    if (!apiConfigChanged()) {
      await quickSave();
      return;
    }

    // If custom endpoint, request optional host permission first
    if (provider === 'custom') {
      try {
        const parsedUrl = new URL(customUrl);
        const originPattern = `${parsedUrl.protocol}//${parsedUrl.host}/*`;

        chrome.permissions.contains({ origins: [originPattern] }, (hasPermission) => {
          if (!hasPermission) {
            chrome.permissions.request({ origins: [originPattern] }, (granted) => {
              if (granted) {
                verifyAndSave();
              } else {
                setLoading(false);
                showNotification('Permission to access the custom host was denied. Extension requests to this endpoint will fail due to CORS. Please grant host permissions.', 'error');
              }
            });
          } else {
            verifyAndSave();
          }
        });
      } catch (urlErr) {
        setLoading(false);
        showNotification('Invalid Custom Endpoint URL. Please input a complete URL, e.g. http://127.0.0.1:8000/v1/embeddings', 'error');
      }
    } else {
      verifyAndSave();
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
