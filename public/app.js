document.addEventListener('DOMContentLoaded', () => {
    // Connect to WebSocket server
    const socket = io();
    
    // DOM elements
    const loginPage = document.getElementById('login-page');
    const dashboard = document.getElementById('dashboard');
    const loginForm = document.getElementById('login-form');
    const walletAddress = document.getElementById('wallet-address');
    const availableBalance = document.getElementById('available-balance');
    const lockedBalances = document.getElementById('locked-balances');
    const viewTransactions = document.getElementById('view-transactions');
    const transactionsModal = new bootstrap.Modal(document.getElementById('transactions-modal'));
    const transactionsList = document.getElementById('transactions-list');
    const refreshData = document.getElementById('refresh-data');
    const showTransferFields = document.getElementById('show-transfer-fields');
    const transferFields = document.getElementById('transfer-fields');
    const destinationAddress = document.getElementById('destination-address');
    const transferAmount = document.getElementById('transfer-amount');
    const startBot = document.getElementById('start-bot');
    const stopBot = document.getElementById('stop-bot');
    const logContainer = document.getElementById('log-container');
    const clearLogs = document.getElementById('clear-logs');
    
    // Toast notification
    const toast = new bootstrap.Toast(document.getElementById('toast-notification'));
    const toastMessage = document.getElementById('toast-message');
    
    // State management
    let isLoggedIn = false;
    let isBotRunning = false;
    
    // Auto-refresh balances interval
    let refreshInterval;
    
    // Helper functions
    function showNotification(message, type = 'danger') {
        toastMessage.textContent = message;
        document.getElementById('toast-notification').className = `toast align-items-center text-white bg-${type} border-0`;
        toast.show();
    }
    
    function addLogEntry(message) {
        // Extract timestamp if available
        let timestamp = '';
        let content = message;
        
        const timestampMatch = message.match(/\[(.*?)\]/);
        if (timestampMatch) {
            timestamp = timestampMatch[1];
            content = message.replace(/\[.*?\]\s*/, '');
        } else {
            const now = new Date();
            timestamp = now.toISOString();
        }
        
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.innerHTML = `
            <span class="log-timestamp">[${timestamp}]</span>
            <span class="log-content">${content}</span>
        `;
        
        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;
        
        // Keep only the last 200 log entries
        while (logContainer.children.length > 200) {
            logContainer.removeChild(logContainer.firstChild);
        }
    }
    
    function updateLockedBalances(balances) {
        if (!balances || balances.length === 0) {
            lockedBalances.innerHTML = '<div class="text-muted">No locked balances found</div>';
            return;
        }
        
        lockedBalances.innerHTML = '';
        balances.forEach(balance => {
            const unlockTime = balance.unlockTime ? new Date(balance.unlockTime) : null;
            const now = new Date();
            const isUnlocked = !unlockTime || now >= unlockTime;
            
            const balanceEl = document.createElement('div');
            balanceEl.className = 'locked-balance-item';
            balanceEl.innerHTML = `
                <div class="locked-balance-amount ${isUnlocked ? 'text-success' : 'text-warning'}">
                    ${balance.amount} PI
                </div>
                <div class="locked-balance-id">
                    ID: ${balance.id.substr(0, 8)}...${balance.id.substr(-8)}
                </div>
                ${unlockTime ? `
                <div class="locked-balance-unlock-time">
                    ${isUnlocked ? 'UNLOCKED' : 'Unlocks at: ' + unlockTime.toLocaleString()}
                </div>
                ` : '<div class="locked-balance-unlock-time">No time lock</div>'}
            `;
            
            lockedBalances.appendChild(balanceEl);
        });
    }
    
    function renderTransactions(transactions) {
        if (!transactions || transactions.length === 0) {
            transactionsList.innerHTML = '<div class="text-muted">No recent transactions found</div>';
            return;
        }
        
        transactionsList.innerHTML = '';
        transactions.forEach(tx => {
            const txDate = new Date(tx.created_at);
            
            const txEl = document.createElement('div');
            txEl.className = 'transaction-item';
            
            let operationsHtml = '';
            if (tx.operations && tx.operations.length > 0) {
                tx.operations.forEach(op => {
                    operationsHtml += `
                        <div class="operation-item">
                            <strong>${op.type}</strong>
                            ${op.amount ? `<div>Amount: ${op.amount} ${op.asset || 'PI'}</div>` : ''}
                            ${op.from ? `<div>From: ${op.from.substr(0, 8)}...${op.from.substr(-8)}</div>` : ''}
                            ${op.to ? `<div>To: ${op.to.substr(0, 8)}...${op.to.substr(-8)}</div>` : ''}
                        </div>
                    `;
                });
            } else {
                operationsHtml = '<div class="text-muted">No operation details available</div>';
            }
            
            txEl.innerHTML = `
                <div class="transaction-header">
                    <strong>TX ID: ${tx.id.substr(0, 8)}...${tx.id.substr(-8)}</strong>
                    <small>${txDate.toLocaleString()}</small>
                </div>
                <div class="transaction-operations">
                    ${operationsHtml}
                </div>
            `;
            
            transactionsList.appendChild(txEl);
        });
    }
    
    // Socket.io event handlers
    socket.on('connect', () => {
        addLogEntry('Connected to server');
    });
    
    socket.on('disconnect', () => {
        addLogEntry('Disconnected from server');
        isLoggedIn = false;
        isBotRunning = false;
        loginPage.classList.remove('d-none');
        dashboard.classList.add('d-none');
        
        // Clear refresh interval
        if (refreshInterval) {
            clearInterval(refreshInterval);
        }
    });
    
    socket.on('error', (message) => {
        showNotification(message);
        addLogEntry(`Error: ${message}`);
    });
    
    socket.on('log', (message) => {
        addLogEntry(message);
    });
    
    socket.on('login_success', (data) => {
        isLoggedIn = true;
        loginPage.classList.add('d-none');
        dashboard.classList.remove('d-none');
        
        // Update UI with wallet data
        walletAddress.textContent = data.publicKey;
        
        // Update balance
        if (data.accountDetails && data.accountDetails.length > 0) {
            const nativeBalance = data.accountDetails.find(b => b.asset_type === 'native');
            if (nativeBalance) {
                availableBalance.textContent = `${parseFloat(nativeBalance.balance).toFixed(7)} PI`;
            }
        }
        
        // Update locked balances
        updateLockedBalances(data.claimableBalances);
        
        showNotification('Successfully logged in!', 'success');
        addLogEntry('Login successful');
        
        // Start auto-refresh of balances (every 5 seconds)
        refreshInterval = setInterval(() => {
            socket.emit('refresh_data');
        }, 5000);
    });
    
    socket.on('balance', (balances) => {
        if (balances && balances.length > 0) {
            const nativeBalance = balances.find(b => b.asset_type === 'native');
            if (nativeBalance) {
                availableBalance.textContent = `${parseFloat(nativeBalance.balance).toFixed(7)} PI`;
            }
        }
    });
    
    socket.on('transactions', (transactions) => {
        renderTransactions(transactions);
        transactionsModal.show();
    });
    
    socket.on('refresh_data', (data) => {
        // Update balance
        if (data.accountDetails && data.accountDetails.length > 0) {
            const nativeBalance = data.accountDetails.find(b => b.asset_type === 'native');
            if (nativeBalance) {
                availableBalance.textContent = `${parseFloat(nativeBalance.balance).toFixed(7)} PI`;
            }
        }
        
        // Update locked balances
        updateLockedBalances(data.claimableBalances);
    });
    
    socket.on('bot_started', () => {
        isBotRunning = true;
        startBot.classList.add('d-none');
        stopBot.classList.remove('d-none');
        showNotification('Bot started in TRUE concurrent mode!', 'success');
    });
    
    socket.on('bot_stopped', () => {
        isBotRunning = false;
        startBot.classList.remove('d-none');
        stopBot.classList.add('d-none');
        showNotification('Bot stopped', 'warning');
    });
    
    socket.on('transfer_started', () => {
        showNotification('Transfer process started!', 'info');
    });
    
    socket.on('claiming_started', () => {
        showNotification('Claiming process started!', 'info');
    });
    
    socket.on('claimed', (data) => {
        showNotification(`Claimed ${data.amount} PI!`, 'success');
    });
    
    socket.on('transferred', (data) => {
        showNotification(`Transferred ${data.amount} PI!`, 'success');
    });
    
    // UI event handlers
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const mnemonic = document.getElementById('mnemonic').value.trim();
        
        // Basic validation
        const words = mnemonic.split(/\s+/);
        if (words.length !== 24) {
            showNotification('Please enter a valid 24-word mnemonic phrase');
            return;
        }
        
        // Show loading state
        document.querySelector('#login-form button').innerHTML = `
            <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
            Logging in...
        `;
        document.querySelector('#login-form button').disabled = true;
        
        // Send login request
        socket.emit('login', { mnemonic });
        
        // Reset form after submission
        document.getElementById('mnemonic').value = '';
    });
    
    refreshData.addEventListener('click', () => {
        refreshData.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Refreshing...
        `;
        refreshData.disabled = true;
        
        socket.emit('refresh_data');
        
        setTimeout(() => {
            refreshData.innerHTML = `<i class="fas fa-sync-alt"></i> Refresh`;
            refreshData.disabled = false;
        }, 2000);
    });
    
    viewTransactions.addEventListener('click', () => {
        viewTransactions.innerHTML = `
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            Loading...
        `;
        viewTransactions.disabled = true;
        
        socket.emit('get_transactions');
        
        setTimeout(() => {
            viewTransactions.innerHTML = 'View Recent Transactions';
            viewTransactions.disabled = false;
        }, 2000);
    });
    
    showTransferFields.addEventListener('click', () => {
        transferFields.classList.remove('d-none');
        showTransferFields.classList.add('d-none');
    });
    
    startBot.addEventListener('click', () => {
        const destination = destinationAddress.value.trim();
        const amount = transferAmount.value.trim();
        
        // Validate destination address
        if (!destination || !destination.startsWith('G') || destination.length !== 56) {
            showNotification('Please enter a valid destination address');
            return;
        }
        
        // Optional amount validation
        if (amount && (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)) {
            showNotification('Please enter a valid amount');
            return;
        }
        
        startBot.innerHTML = `
            <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
            Starting...
        `;
        startBot.disabled = true;
        
        // Start the bot in TRUE concurrent mode
        socket.emit('start_bot', { 
            destination, 
            amount: amount ? parseFloat(amount) : null 
        });
    });
    
    stopBot.addEventListener('click', () => {
        stopBot.innerHTML = `
            <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
            Stopping...
        `;
        stopBot.disabled = true;
        
        // Stop the bot
        socket.emit('stop_bot');
        
        setTimeout(() => {
            stopBot.innerHTML = 'STOP BOT';
            stopBot.disabled = false;
        }, 2000);
    });
    
    clearLogs.addEventListener('click', () => {
        logContainer.innerHTML = '<div class="text-muted p-3">Logs cleared...</div>';
    });
});