// Enhanced Pi Network Sweeper Bot with TRUE Concurrent Operations
import * as ed25519 from 'ed25519-hd-key';
import StellarSdk from 'stellar-sdk';
import * as bip39 from 'bip39';

// Enhanced Configuration
const config = {
    horizonUrl: 'https://api.mainnet.minepi.com',
    networkPassphrase: 'Pi Network',
    baseFee: 150000,              // 0.015 PI - increased base fee
    maxFee: 2000000,              // 0.2 PI - increased for higher priority
    feePriorityMultiplier: 3.0,   // More aggressive fee escalation
    maxSubmissionAttempts: 10,    // More persistent retries
    floodCount: 10,               // Much more aggressive flooding
    floodInterval: 50,            // Even faster flooding (reduced interval)
    debug: true,
    pollingInterval: 1000,        // Faster polling (check more frequently)
    transferPollingInterval: 1000, // Separate polling for transfers
};

class TrueConcurrentPiBot {
    constructor(targetMnemonic, destination = null) {
        this.dest = destination; // Can be null initially and set later
        this.targetKP = this.mnemonicToKeypair(targetMnemonic);
        this.server = new StellarSdk.Server(config.horizonUrl, { allowHttp: false });
        this.network = config.networkPassphrase;
        this.currentFee = config.baseFee;
        this.transferFee = config.baseFee; // Separate fee tracking for transfers
        this.claimableUrl = `${config.horizonUrl}/claimable_balances?claimant=${this.targetKP.publicKey()}`;
        
        // Control flags
        this.isClaimingRunning = false;
        this.isTransferringRunning = false;
        
        // Event system
        this.eventListeners = {
            'log': [],
            'balance': [],
            'claimed': [],
            'transferred': [],
            'error': []
        };
        
        // For tracking operations
        this.activeOperations = {
            claiming: new Set(),
            transferring: new Set()
        };
        
        // Initialize account object
        this.account = null;
        this.lastBalanceCheck = 0;
        
        // Transfer settings
        this.transferAmount = null; // null means max available
        this.transferInterval = null;
        this.claimInterval = null;
    }
    
    // Event system methods
    on(event, callback) {
        if (this.eventListeners[event]) {
            this.eventListeners[event].push(callback);
        }
        return this;
    }
    
    emit(event, data) {
        if (this.eventListeners[event]) {
            for (const callback of this.eventListeners[event]) {
                callback(data);
            }
        }
    }
    
    log(msg) {
        const logMsg = `[${new Date().toISOString()}] ${msg}`;
        if (config.debug) console.log(logMsg);
        this.emit('log', logMsg);
    }

    mnemonicToKeypair(mnemonic) {
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const path = "m/44'/314159'/0'";
        const { key } = ed25519.derivePath(path, seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
    }

    // Set destination address
    setDestination(address) {
        this.dest = address;
        this.log(`Destination wallet set to: ${address}`);
    }
    
    // Set transfer amount (null for max available)
    setTransferAmount(amount) {
        this.transferAmount = amount;
        this.log(`Transfer amount set to: ${amount === null ? 'MAX AVAILABLE' : amount}`);
    }
    
    // Get wallet public key
    getPublicKey() {
        return this.targetKP.publicKey();
    }
    
    // Fetch account details and update balances
    async getAccountDetails(force = false) {
        // Only refresh if forced or if last check was more than 1 second ago
        const now = Date.now();
        if (!force && now - this.lastBalanceCheck < 1000) {
            return this.account ? this.account.balances : [];
        }
        
        try {
            this.account = await this.server.loadAccount(this.targetKP.publicKey());
            this.lastBalanceCheck = now;
            
            const balances = this.account.balances.map(balance => {
                if (balance.asset_type === 'native') {
                    return {
                        asset: 'PI',
                        balance: balance.balance,
                        asset_type: 'native'
                    };
                } else {
                    return {
                        asset: `${balance.asset_code}:${balance.asset_issuer}`,
                        balance: balance.balance,
                        asset_type: balance.asset_type
                    };
                }
            });
            
            this.emit('balance', balances);
            return balances;
        } catch (err) {
            this.log(`Failed to load account: ${err.message}`);
            this.emit('error', `Account error: ${err.message}`);
            return [];
        }
    }
    
    // Get available PI balance
    async getAvailablePiBalance() {
        const balances = await this.getAccountDetails();
        const nativeBalance = balances.find(b => b.asset_type === 'native');
        if (nativeBalance) {
            // Keep 2.0 PI for reserves and fees (increased reserve)
            return Math.max(0, parseFloat(nativeBalance.balance) - 2.0);
        }
        return 0;
    }
    
    // Get recent transactions
    async getRecentTransactions(limit = 5) {
        try {
            const transactions = await this.server.transactions()
                .forAccount(this.targetKP.publicKey())
                .limit(limit)
                .order('desc')
                .call();
                
            const txDetails = await Promise.all(transactions.records.map(async tx => {
                try {
                    const operations = await tx.operations();
                    return {
                        id: tx.id,
                        created_at: tx.created_at,
                        operations: operations.records.map(op => ({
                            type: op.type,
                            amount: op.amount || null,
                            from: op.from || null,
                            to: op.to || op.destination || null,
                            asset: op.asset_type === 'native' ? 'PI' : `${op.asset_code}:${op.asset_issuer}`
                        }))
                    };
                } catch (err) {
                    return {
                        id: tx.id,
                        created_at: tx.created_at,
                        operations: [],
                        error: err.message
                    };
                }
            }));
            
            return txDetails;
        } catch (err) {
            this.log(`Failed to fetch transactions: ${err.message}`);
            return [];
        }
    }

    // Fetch all claimable balances for target
    async getAllClaimableBalances() {
        try {
            const resp = await this.server
                .claimableBalances()
                .claimant(this.targetKP.publicKey())
                .limit(100)
                .call();
                
            // Add timestamp information from the predicates
            const enhancedBalances = resp.records.map(balance => {
                let unlockTime = null;
                
                // Extract timestamp from predicates if present
                if (balance.claimants && balance.claimants.length > 0) {
                    for (const claimant of balance.claimants) {
                        if (claimant.destination === this.targetKP.publicKey() && 
                            claimant.predicate && 
                            claimant.predicate.not && 
                            claimant.predicate.not.abs_before) {
                            // Convert ledger timestamp to JS Date
                            unlockTime = new Date(claimant.predicate.not.abs_before);
                            break;
                        }
                    }
                }
                
                return {
                    ...balance,
                    unlockTime
                };
            });
            
            return enhancedBalances;
        } catch (err) {
            this.log(`Failed to fetch claimable balances: ${err.message}`);
            this.emit('error', `Claimable balance error: ${err.message}`);
            return [];
        }
    }

    // Update fee stats for claiming operations
    async updateClaimFeeStats() {
        try {
            const stats = await this.server.feeStats();
            const p95 = parseInt(stats.fee_charged.p95, 10); // Use p95 for even higher priority
            let fee = Math.max(p95 * config.feePriorityMultiplier, config.baseFee);
            this.currentFee = Math.min(Math.ceil(fee / 100) * 100, config.maxFee);
            this.log(`Claim fee updated: ${this.currentFee} stroops`);
        } catch (err) {
            this.log(`Failed to update claim fees: ${err.message}`);
            // Keep using the current fee
        }
    }
    
    // Update fee stats for transfer operations
    async updateTransferFeeStats() {
        try {
            const stats = await this.server.feeStats();
            // Use p99 for transfers to make them highest priority
            const p99 = parseInt(stats.fee_charged.p99, 10); 
            let fee = Math.max(p99 * config.feePriorityMultiplier, config.baseFee);
            this.transferFee = Math.min(Math.ceil(fee / 100) * 100, config.maxFee);
            this.log(`Transfer fee updated: ${this.transferFee} stroops`);
        } catch (err) {
            this.log(`Failed to update transfer fees: ${err.message}`);
            // Keep using the current fee
        }
    }

    // Build transaction for claiming a balance
    async buildClaimTx(balanceId) {
        try {
            const account = await this.server.loadAccount(this.targetKP.publicKey());
            return new StellarSdk.TransactionBuilder(account, {
                fee: String(this.currentFee),
                networkPassphrase: this.network,
            })
                .addOperation(StellarSdk.Operation.claimClaimableBalance({
                    balanceId
                }))
                .setTimeout(180)
                .build();
        } catch (err) {
            this.log(`Failed to build claim transaction: ${err.message}`);
            throw err;
        }
    }
    
    // Build transaction for transferring balance
    async buildTransferTx(amount) {
        if (!this.dest) {
            throw new Error("Destination address not set");
        }
        
        try {
            const account = await this.server.loadAccount(this.targetKP.publicKey());
            return new StellarSdk.TransactionBuilder(account, {
                fee: String(this.transferFee), // Use separate transfer fee
                networkPassphrase: this.network,
            })
                .addOperation(StellarSdk.Operation.payment({
                    destination: this.dest,
                    asset: StellarSdk.Asset.native(),
                    amount: amount.toString()
                }))
                .setTimeout(180)
                .build();
        } catch (err) {
            this.log(`Failed to build transfer transaction: ${err.message}`);
            throw err;
        }
    }

    // Process a single claimable balance
    async processClaim(balance) {
        if (this.activeOperations.claiming.has(balance.id)) {
            return; // Already processing this claim
        }
        
        this.activeOperations.claiming.add(balance.id);
        this.log(`Starting claim process for balance ${balance.id} (${balance.amount} PI)`);
        
        let attempt = 0;
        while (attempt < config.maxSubmissionAttempts && this.isClaimingRunning) {
            try {
                await this.updateClaimFeeStats(); // Always get latest fees
                const tx = await this.buildClaimTx(balance.id);
                tx.sign(this.targetKP);
                
                const res = await this.server.submitTransaction(tx);
                this.log(`Claim success (hash=${res.hash})`);
                
                // ULTRA AGGRESSIVE FLOODING - Immediately flood duplicates
                for (let i = 0; i < config.floodCount; i++) {
                    // Use zero delay for first few duplicates
                    const delay = i < 3 ? 0 : i * config.floodInterval;
                    setTimeout(() => {
                        this.server.submitTransaction(tx).catch(() => {});
                    }, delay);
                }
                
                // Emit claimed event
                this.emit('claimed', {
                    id: balance.id,
                    amount: balance.amount,
                    hash: res.hash
                });
                
                this.activeOperations.claiming.delete(balance.id);
                
                // Trigger an immediate balance refresh
                this.getAccountDetails(true);
                
                return true;
            } catch (err) {
                this.log(`Claim attempt ${attempt + 1} failed: ${err.message}`);
                attempt++;
                
                // Bidding war: bump fee aggressively
                this.currentFee = Math.min(
                    Math.ceil(this.currentFee * config.feePriorityMultiplier / 50) * 100, // More aggressive fee increase
                    config.maxFee
                );
                this.log(`Bumping claim fee to ${this.currentFee}`);
                
                // Minimal delay before retry
                await new Promise(res => setTimeout(res, 50));
            }
        }
        
        this.log(`Failed to claim balance ${balance.id} after ${attempt} attempts`);
        this.activeOperations.claiming.delete(balance.id);
        return false;
    }
    
    // Process a transfer of specified amount
    async processTransfer(amount) {
        if (!this.isTransferringRunning || !this.dest) {
            return false;
        }
        
        const transferKey = `transfer-${Date.now()}`;
        this.activeOperations.transferring.add(transferKey);
        
        this.log(`Starting transfer process for ${amount} PI to ${this.dest}`);
        
        let attempt = 0;
        while (attempt < config.maxSubmissionAttempts && this.isTransferringRunning) {
            try {
                await this.updateTransferFeeStats(); // Always get latest fees
                const tx = await this.buildTransferTx(amount);
                tx.sign(this.targetKP);
                
                const res = await this.server.submitTransaction(tx);
                this.log(`Transfer success (hash=${res.hash})`);
                
                // ULTRA AGGRESSIVE FLOODING - Immediately flood duplicates
                for (let i = 0; i < config.floodCount; i++) {
                    // Use zero delay for first few duplicates
                    const delay = i < 3 ? 0 : i * config.floodInterval;
                    setTimeout(() => {
                        this.server.submitTransaction(tx).catch(() => {});
                    }, delay);
                }
                
                // Emit transferred event
                this.emit('transferred', {
                    amount,
                    destination: this.dest,
                    hash: res.hash
                });
                
                this.activeOperations.transferring.delete(transferKey);
                
                // Trigger an immediate balance refresh
                this.getAccountDetails(true);
                
                return true;
            } catch (err) {
                this.log(`Transfer attempt ${attempt + 1} failed: ${err.message}`);
                attempt++;
                
                // Bidding war: bump fee aggressively
                this.transferFee = Math.min(
                    Math.ceil(this.transferFee * config.feePriorityMultiplier / 50) * 100, // More aggressive fee increase
                    config.maxFee
                );
                this.log(`Bumping transfer fee to ${this.transferFee}`);
                
                // Minimal delay before retry
                await new Promise(res => setTimeout(res, 50));
            }
        }
        
        this.log(`Failed to transfer ${amount} PI after ${attempt} attempts`);
        this.activeOperations.transferring.delete(transferKey);
        return false;
    }

    // COMPLETELY SEPARATE claiming process loop
    async startClaimingLoop() {
        if (!this.isClaimingRunning) return;
        
        try {
            const balances = await this.getAllClaimableBalances();
            
            if (!balances.length) {
                this.log('No claimable balances found');
            } else {
                this.log(`Found ${balances.length} claimable balances`);
                
                // Filter unlockable balances
                const unlockableBalances = balances.filter(bal => {
                    if (bal.unlockTime) {
                        return new Date() >= bal.unlockTime;
                    }
                    return true; // If no timestamp, assume it's claimable
                });
                
                if (unlockableBalances.length === 0) {
                    this.log('No unlocked balances available for claiming');
                } else {
                    // Start processing all unlockable balances at once
                    this.log(`Processing ${unlockableBalances.length} unlocked balances`);
                    unlockableBalances.forEach(bal => {
                        // Don't await - let them all run in parallel!
                        this.processClaim(bal);
                    });
                }
            }
        } catch (err) {
            this.log(`Error in claiming loop: ${err.message}`);
        }
        
        // Schedule next claiming loop iteration if still running
        if (this.isClaimingRunning) {
            setTimeout(() => this.startClaimingLoop(), config.pollingInterval);
        }
    }
    
    // COMPLETELY SEPARATE transfer process loop
    async startTransferLoop() {
        if (!this.isTransferringRunning || !this.dest) return;
        
        try {
            // Check available balance
            const availableBalance = await this.getAvailablePiBalance();
            
            if (availableBalance <= 0) {
                this.log('Insufficient balance for transfer');
            } else {
                const transferAmount = this.transferAmount === null ? 
                    availableBalance : // Use all available
                    Math.min(this.transferAmount, availableBalance); // Use specified amount or max available
                
                if (transferAmount > 0) {
                    // Format to 7 decimal places max
                    const formattedAmount = parseFloat(transferAmount).toFixed(7);
                    this.log(`Available for transfer: ${formattedAmount} PI`);
                    
                    // Don't await - let it run independently!
                    this.processTransfer(formattedAmount);
                }
            }
        } catch (err) {
            this.log(`Error in transfer loop: ${err.message}`);
        }
        
        // Schedule next transfer loop iteration if still running
        if (this.isTransferringRunning) {
            setTimeout(() => this.startTransferLoop(), config.transferPollingInterval);
        }
    }
    
    // Start both claiming and transfer processes as TRUE SEPARATE PROCESSES
    start() {
        this.log('Bot starting in TRUE concurrent mode...');
        
        // Start claiming process
        this.isClaimingRunning = true;
        this.startClaimingLoop();
        
        // Start transfer process (if destination is set)
        if (this.dest) {
            this.isTransferringRunning = true;
            this.startTransferLoop();
        } else {
            this.log('WARNING: Destination not set, transfer process not started');
        }
        
        return this;
    }
    
    // Start only the transfer process
    startTransferOnly() {
        this.log('Starting transfer process only...');
        this.isTransferringRunning = true;
        this.startTransferLoop();
        return this;
    }
    
    // Start only the claiming process
    startClaimingOnly() {
        this.log('Starting claiming process only...');
        this.isClaimingRunning = true;
        this.startClaimingLoop();
        return this;
    }
    
    // Stop all processes
    stop() {
        this.isClaimingRunning = false;
        this.isTransferringRunning = false;
        this.log('Bot stopped');
        return this;
    }
}

export default TrueConcurrentPiBot;