const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/users',      require('./routes/users'));
app.use('/api/services',   require('./routes/services'));
app.use('/api/metrics',    require('./routes/metrics'));
app.use('/api/alerts',     require('./routes/alerts'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// pg LISTEN/NOTIFY → Socket.IO broadcast
const listenerPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'postgres',
  user: process.env.PG_USER || 'app',
  password: process.env.PG_PASSWORD || 'app_secret_2025',
});

listenerPool.connect().then(client => {
  client.query('LISTEN new_metric');
  client.on('notification', msg => {
    io.emit('metric', JSON.parse(msg.payload));
  });
}).catch(err => console.error('LISTEN error:', err.message));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`API listening on :${PORT}`));
