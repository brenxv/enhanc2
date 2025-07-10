import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import TrueConcurrentPiBot from './enhanced-pi-fast-bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// Store active bots by socket id
const activeBots = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Handle login with mnemonic
  socket.on('login', async (data) => {
    try {
      const { mnemonic } = data;
      
      // Validate mnemonic (basic check)
      const words = mnemonic.trim().split(/\s+/);
      if (words.length !== 24) {
        return socket.emit('error', 'Invalid mnemonic: Must contain exactly 24 words');
      }
      
      // Create new bot instance
      const bot = new TrueConcurrentPiBot(mnemonic);
      
      // Set up event listeners to forward to client
      bot.on('log', (message) => {
        socket.emit('log', message);
      });
      
      bot.on('balance', (balances) => {
        socket.emit('balance', balances);
      });
      
      bot.on('claimed', (data) => {
        socket.emit('claimed', data);
      });
      
      bot.on('transferred', (data) => {
        socket.emit('transferred', data);
      });
      
      bot.on('error', (error) => {
        socket.emit('error', error);
      });
      
      // Store bot instance
      activeBots.set(socket.id, bot);
      
      // Get initial account details
      const publicKey = bot.getPublicKey();
      const accountDetails = await bot.getAccountDetails();
      const claimableBalances = await bot.getAllClaimableBalances();
      
      // Send login success response
      socket.emit('login_success', {
        publicKey,
        accountDetails,
        claimableBalances
      });
      
    } catch (err) {
      console.error('Login error:', err);
      socket.emit('error', `Login failed: ${err.message}`);
    }
  });
  
  // Get recent transactions
  socket.on('get_transactions', async () => {
    const bot = activeBots.get(socket.id);
    if (!bot) {
      return socket.emit('error', 'Not logged in');
    }
    
    try {
      const transactions = await bot.getRecentTransactions();
      socket.emit('transactions', transactions);
    } catch (err) {
      socket.emit('error', `Failed to fetch transactions: ${err.message}`);
    }
  });
  
  // Refresh account data
  socket.on('refresh_data', async () => {
    const bot = activeBots.get(socket.id);
    if (!bot) {
      return socket.emit('error', 'Not logged in');
    }
    
    try {
      const accountDetails = await bot.getAccountDetails(true); // Force refresh
      const claimableBalances = await bot.getAllClaimableBalances();
      
      socket.emit('refresh_data', {
        accountDetails,
        claimableBalances
      });
    } catch (err) {
      socket.emit('error', `Failed to refresh data: ${err.message}`);
    }
  });
  
  // Start bot with destination address
  socket.on('start_bot', (data) => {
    const bot = activeBots.get(socket.id);
    if (!bot) {
      return socket.emit('error', 'Not logged in');
    }
    
    try {
      const { destination, amount } = data;
      
      // Validate destination address (basic check for Stellar address format)
      if (!destination || !destination.startsWith('G') || destination.length !== 56) {
        return socket.emit('error', 'Invalid destination address');
      }
      
      // Set destination and amount
      bot.setDestination(destination);
      bot.setTransferAmount(amount ? parseFloat(amount) : null);
      
      // Start both processes in TRUE concurrent mode
      bot.start();
      
      socket.emit('bot_started');
    } catch (err) {
      socket.emit('error', `Failed to start bot: ${err.message}`);
    }
  });
  
  // Stop bot
  socket.on('stop_bot', () => {
    const bot = activeBots.get(socket.id);
    if (!bot) {
      return socket.emit('error', 'Not logged in');
    }
    
    bot.stop();
    socket.emit('bot_stopped');
  });
  
  // Execute an immediate transfer only
  socket.on('execute_transfer_only', (data) => {
    const bot = activeBots.get(socket.id);
    if (!bot) {
      return socket.emit('error', 'Not logged in');
    }
    
    try {
      const { destination, amount } = data;
      
      // Validate destination address
      if (!destination || !destination.startsWith('G') || destination.length !== 56) {
        return socket.emit('error', 'Invalid destination address');
      }
      
      // Set destination and amount
      bot.setDestination(destination);
      bot.setTransferAmount(amount ? parseFloat(amount) : null);
      
      // Start transfer process only
      bot.startTransferOnly();
      
      socket.emit('transfer_started');
    } catch (err) {
      socket.emit('error', `Transfer failed: ${err.message}`);
    }
  });
  
  // Execute a claiming operation only
  socket.on('execute_claiming_only', () => {
    const bot = activeBots.get(socket.id);
    if (!bot) {
      return socket.emit('error', 'Not logged in');
    }
    
    try {
      // Start claiming process only
      bot.startClaimingOnly();
      socket.emit('claiming_started');
    } catch (err) {
      socket.emit('error', `Claiming failed: ${err.message}`);
    }
  });
  
  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    // Clean up bot instance
    const bot = activeBots.get(socket.id);
    if (bot) {
      bot.stop();
      activeBots.delete(socket.id);
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});