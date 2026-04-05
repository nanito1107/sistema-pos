/**
 * Sistema POS Multi-Tienda - Backend Node.js con MySQL
 * Cada tienda tiene sus propios destinos y configuración
 * Requisitos: npm install express mysql2 cors body-parser axios dotenv bcrypt jsonwebtoken
 * Ejecutar: node server.js
 */

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'tu_clave_secreta_super_segura_cambiala';
const SALT_ROUNDS = 10;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Configuración de MySQL
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pos_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Pool de conexiones MySQL
const pool = mysql.createPool(dbConfig);

// Middleware de autenticación
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido o expirado' });
    }
    req.user = user;
    next();
  });
};

// Middleware para verificar rol de administrador
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado: Se requieren permisos de administrador' });
  }
  next();
};

// Función para inicializar la base de datos
async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    
    console.log('Conectado a MySQL');
    
    // Crear tabla de tiendas
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE NOT NULL,
        address TEXT,
        city VARCHAR(100),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_code (code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // Crear tabla de usuarios (ahora con store_id)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        role ENUM('admin', 'vendedor') NOT NULL DEFAULT 'vendedor',
        store_id INT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_login TIMESTAMP NULL,
        INDEX idx_username (username),
        INDEX idx_role (role),
        INDEX idx_store_id (store_id),
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // Crear tienda demo si no existe
    const [storeExists] = await connection.query('SELECT id FROM stores WHERE code = ?', ['DEMO']);
    let demoStoreId;
    
    if (storeExists.length === 0) {
      const [storeResult] = await connection.query(
        'INSERT INTO stores (name, code, address, city) VALUES (?, ?, ?, ?)',
        ['Tienda Demo', 'DEMO', 'Dirección Demo', 'Santiago']
      );
      demoStoreId = storeResult.insertId;
      console.log('✅ Tienda demo creada');
    } else {
      demoStoreId = storeExists[0].id;
    }
    
    // Crear usuario administrador por defecto si no existe
    const [adminExists] = await connection.query('SELECT id FROM users WHERE username = ?', ['admin']);
    
    if (adminExists.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', SALT_ROUNDS);
      await connection.query(
        'INSERT INTO users (username, password, full_name, role, store_id) VALUES (?, ?, ?, ?, ?)',
        ['admin', hashedPassword, 'Administrador', 'admin', null]
      );
      console.log('✅ Usuario administrador creado: admin/admin123 (CAMBIAR CONTRASEÑA)');
    }
    
    // Crear tabla de productos (ahora con store_id)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id INT NOT NULL,
        barcode VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        value DECIMAL(10, 2) NOT NULL,
        stock INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_barcode (barcode),
        INDEX idx_name (name),
        INDEX idx_store_id (store_id),
        UNIQUE KEY unique_barcode_per_store (store_id, barcode),
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // Crear tabla de destinos (ahora con store_id)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS destinations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        server VARCHAR(255) NOT NULL,
        webhook_id VARCHAR(255) NOT NULL,
        secret VARCHAR(255) NOT NULL,
        register_id VARCHAR(255) NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_store_id (store_id),
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // Crear tabla de transacciones (ahora con store_id)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        store_id INT NOT NULL,
        timestamp DATETIME NOT NULL,
        products_data TEXT NOT NULL,
        total_value DECIMAL(10, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'CLP',
        status VARCHAR(50) NOT NULL,
        details JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_timestamp (timestamp),
        INDEX idx_status (status),
        INDEX idx_user_id (user_id),
        INDEX idx_store_id (store_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    connection.release();
    console.log('✅ Tablas de base de datos creadas/verificadas');
    
  } catch (error) {
    console.error('❌ Error al inicializar la base de datos:', error.message);
    process.exit(1);
  }
}

// ============= ENDPOINTS DE AUTENTICACIÓN =============

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
    }
    
    // Buscar usuario con información de tienda
    const [users] = await pool.query(
      `SELECT u.id, u.username, u.password, u.full_name, u.role, u.active, u.store_id, 
              s.name as store_name, s.code as store_code
       FROM users u
       LEFT JOIN stores s ON u.store_id = s.id
       WHERE u.username = ?`,
      [username]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    
    const user = users[0];
    
    if (!user.active) {
      return res.status(403).json({ error: 'Usuario inactivo' });
    }
    
    // Verificar contraseña
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    
    // Verificar que la tienda esté activa (si no es admin)
    if (user.store_id) {
      const [stores] = await pool.query('SELECT active FROM stores WHERE id = ?', [user.store_id]);
      if (stores.length === 0 || !stores[0].active) {
        return res.status(403).json({ error: 'Tienda inactiva' });
      }
    }
    
    // Actualizar último login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    
    // Generar token JWT
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        role: user.role,
        full_name: user.full_name,
        store_id: user.store_id,
        store_name: user.store_name,
        store_code: user.store_code
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        store_id: user.store_id,
        store_name: user.store_name,
        store_code: user.store_code
      }
    });
    
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error en el servidor', detail: error.message });
  }
});

// Verificar token
app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      full_name: req.user.full_name,
      role: req.user.role,
      store_id: req.user.store_id,
      store_name: req.user.store_name,
      store_code: req.user.store_code
    }
  });
});

// Cambiar contraseña
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas' });
    }
    
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    const [users] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const validPassword = await bcrypt.compare(current_password, users[0].password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }
    
    const hashedPassword = await bcrypt.hash(new_password, SALT_ROUNDS);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);
    
    res.json({ message: 'Contraseña actualizada exitosamente' });
    
  } catch (error) {
    console.error('Error al cambiar contraseña:', error);
    res.status(500).json({ error: 'Error al cambiar contraseña', detail: error.message });
  }
});

// ============= ENDPOINTS DE TIENDAS (Solo Admin) =============

app.get('/api/stores', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM stores ORDER BY name');
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener tiendas:', error);
    res.status(500).json({ error: 'Error al obtener tiendas', detail: error.message });
  }
});

app.post('/api/stores', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, code, address, city } = req.body;
    
    if (!name || !code) {
      return res.status(400).json({ error: 'Nombre y código son requeridos' });
    }
    
    const [result] = await pool.query(
      'INSERT INTO stores (name, code, address, city) VALUES (?, ?, ?, ?)',
      [name, code.toUpperCase(), address, city]
    );
    
    const [newStore] = await pool.query('SELECT * FROM stores WHERE id = ?', [result.insertId]);
    
    res.status(201).json(newStore[0]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'El código de tienda ya existe' });
    }
    console.error('Error al crear tienda:', error);
    res.status(500).json({ error: 'Error al crear tienda', detail: error.message });
  }
});

app.put('/api/stores/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, code, address, city, active } = req.body;
    const storeId = req.params.id;
    
    const updates = [];
    const values = [];
    
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (code !== undefined) { updates.push('code = ?'); values.push(code.toUpperCase()); }
    if (address !== undefined) { updates.push('address = ?'); values.push(address); }
    if (city !== undefined) { updates.push('city = ?'); values.push(city); }
    if (active !== undefined) { updates.push('active = ?'); values.push(active); }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(storeId);
    
    await pool.query(`UPDATE stores SET ${updates.join(', ')} WHERE id = ?`, values);
    
    const [updated] = await pool.query('SELECT * FROM stores WHERE id = ?', [storeId]);
    
    res.json(updated[0]);
  } catch (error) {
    console.error('Error al actualizar tienda:', error);
    res.status(500).json({ error: 'Error al actualizar tienda', detail: error.message });
  }
});

app.delete('/api/stores/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM stores WHERE id = ?', [req.params.id]);
    res.json({ message: 'Tienda eliminada exitosamente' });
  } catch (error) {
    console.error('Error al eliminar tienda:', error);
    res.status(500).json({ error: 'Error al eliminar tienda', detail: error.message });
  }
});

// ============= ENDPOINTS DE USUARIOS =============

app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.active, u.store_id, u.created_at, u.last_login,
              s.name as store_name, s.code as store_code
       FROM users u
       LEFT JOIN stores s ON u.store_id = s.id
       ORDER BY u.full_name`
    );
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener usuarios:', error);
    res.status(500).json({ error: 'Error al obtener usuarios', detail: error.message });
  }
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { username, password, full_name, role = 'vendedor', store_id } = req.body;
    
    if (!username || !password || !full_name) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    if (!['admin', 'vendedor'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    
    // Vendedores deben tener tienda asignada
    if (role === 'vendedor' && !store_id) {
      return res.status(400).json({ error: 'Los vendedores deben tener una tienda asignada' });
    }
    
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    }
    
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    
    const [result] = await pool.query(
      'INSERT INTO users (username, password, full_name, role, store_id) VALUES (?, ?, ?, ?, ?)',
      [username, hashedPassword, full_name, role, store_id]
    );
    
    const [newUser] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.active, u.store_id,
              s.name as store_name, s.code as store_code
       FROM users u
       LEFT JOIN stores s ON u.store_id = s.id
       WHERE u.id = ?`,
      [result.insertId]
    );
    
    res.status(201).json(newUser[0]);
    
  } catch (error) {
    console.error('Error al crear usuario:', error);
    res.status(500).json({ error: 'Error al crear usuario', detail: error.message });
  }
});

app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { full_name, role, active, password, store_id } = req.body;
    const userId = req.params.id;
    
    const [existing] = await pool.query('SELECT id, role FROM users WHERE id = ?', [userId]);
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const updates = [];
    const values = [];
    
    if (full_name !== undefined) { updates.push('full_name = ?'); values.push(full_name); }
    if (role !== undefined && ['admin', 'vendedor'].includes(role)) { 
      updates.push('role = ?'); 
      values.push(role); 
    }
    if (active !== undefined) { updates.push('active = ?'); values.push(active); }
    if (store_id !== undefined) { updates.push('store_id = ?'); values.push(store_id); }
    
    if (password && password.length >= 6) {
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      updates.push('password = ?');
      values.push(hashedPassword);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(userId);
    
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    
    const [updated] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.active, u.store_id,
              s.name as store_name, s.code as store_code
       FROM users u
       LEFT JOIN stores s ON u.store_id = s.id
       WHERE u.id = ?`,
      [userId]
    );
    
    res.json(updated[0]);
    
  } catch (error) {
    console.error('Error al actualizar usuario:', error);
    res.status(500).json({ error: 'Error al actualizar usuario', detail: error.message });
  }
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    if (parseInt(userId) === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    }
    
    const [existing] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    
    res.json({ message: 'Usuario eliminado exitosamente' });
    
  } catch (error) {
    console.error('Error al eliminar usuario:', error);
    res.status(500).json({ error: 'Error al eliminar usuario', detail: error.message });
  }
});

// ============= ENDPOINTS DE PRODUCTOS (Filtrados por tienda) =============

app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    let query = 'SELECT * FROM products';
    let params = [];
    
    // Si no es admin, solo ver productos de su tienda
    if (req.user.role !== 'admin' && req.user.store_id) {
      query += ' WHERE store_id = ?';
      params.push(req.user.store_id);
    }
    
    query += ' ORDER BY name';
    
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ error: 'Error al obtener productos', detail: error.message });
  }
});

app.get('/api/products/barcode/:barcode', authenticateToken, async (req, res) => {
  try {
    let query = 'SELECT * FROM products WHERE barcode = ?';
    let params = [req.params.barcode];
    
    // Si no es admin, solo buscar en su tienda
    if (req.user.role !== 'admin' && req.user.store_id) {
      query += ' AND store_id = ?';
      params.push(req.user.store_id);
    }
    
    const [rows] = await pool.query(query, params);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error al obtener producto:', error);
    res.status(500).json({ error: 'Error al obtener producto', detail: error.message });
  }
});

app.post('/api/products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { barcode, name, value, stock = 0, store_id } = req.body;
    
    if (!barcode || !name || value === undefined || !store_id) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    
    const [existing] = await pool.query(
      'SELECT id FROM products WHERE barcode = ? AND store_id = ?', 
      [barcode, store_id]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'El código de barras ya existe en esta tienda' });
    }
    
    const [result] = await pool.query(
      'INSERT INTO products (store_id, barcode, name, value, stock) VALUES (?, ?, ?, ?, ?)',
      [store_id, barcode, name, parseFloat(value), parseInt(stock)]
    );
    
    const [newProduct] = await pool.query('SELECT * FROM products WHERE id = ?', [result.insertId]);
    
    res.status(201).json(newProduct[0]);
  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ error: 'Error al crear producto', detail: error.message });
  }
});

app.put('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { barcode, name, value, stock, store_id } = req.body;
    const productId = req.params.id;
    
    const [existing] = await pool.query('SELECT id FROM products WHERE id = ?', [productId]);
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    const updates = [];
    const values = [];
    
    if (barcode !== undefined) { updates.push('barcode = ?'); values.push(barcode); }
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (value !== undefined) { updates.push('value = ?'); values.push(parseFloat(value)); }
    if (stock !== undefined) { updates.push('stock = ?'); values.push(parseInt(stock)); }
    if (store_id !== undefined) { updates.push('store_id = ?'); values.push(store_id); }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(productId);
    
    await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, values);
    
    const [updated] = await pool.query('SELECT * FROM products WHERE id = ?', [productId]);
    
    res.json(updated[0]);
  } catch (error) {
    console.error('Error al actualizar producto:', error);
    res.status(500).json({ error: 'Error al actualizar producto', detail: error.message });
  }
});

app.delete('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT id FROM products WHERE id = ?', [req.params.id]);
    
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    
    res.json({ message: 'Producto eliminado exitosamente' });
  } catch (error) {
    console.error('Error al eliminar producto:', error);
    res.status(500).json({ error: 'Error al eliminar producto', detail: error.message });
  }
});

// ============= ENDPOINTS DE DESTINOS (Filtrados por tienda) =============

app.get('/api/destinations', authenticateToken, async (req, res) => {
  try {
    let query = 'SELECT * FROM destinations';
    let params = [];
    
    // Admin puede ver todos, vendedor solo de su tienda
    if (req.user.role !== 'admin' && req.user.store_id) {
      query += ' WHERE store_id = ?';
      params.push(req.user.store_id);
    }
    
    query += ' ORDER BY name';
    
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener destinos:', error);
    res.status(500).json({ error: 'Error al obtener destinos', detail: error.message });
  }
});

app.post('/api/destinations', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, server, webhook_id, secret, register_id, active = true, store_id } = req.body;
    
    if (!name || !server || !webhook_id || !secret || !register_id || !store_id) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    
    const [result] = await pool.query(
      'INSERT INTO destinations (store_id, name, server, webhook_id, secret, register_id, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [store_id, name, server, webhook_id, secret, register_id, active]
    );
    
    const [newDest] = await pool.query('SELECT * FROM destinations WHERE id = ?', [result.insertId]);
    
    res.status(201).json(newDest[0]);
  } catch (error) {
    console.error('Error al crear destino:', error);
    res.status(500).json({ error: 'Error al crear destino', detail: error.message });
  }
});

app.put('/api/destinations/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, server, webhook_id, secret, register_id, active, store_id } = req.body;
    const destId = req.params.id;
    
    const updates = [];
    const values = [];
    
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (server !== undefined) { updates.push('server = ?'); values.push(server); }
    if (webhook_id !== undefined) { updates.push('webhook_id = ?'); values.push(webhook_id); }
    if (secret !== undefined) { updates.push('secret = ?'); values.push(secret); }
    if (register_id !== undefined) { updates.push('register_id = ?'); values.push(register_id); }
    if (active !== undefined) { updates.push('active = ?'); values.push(active); }
    if (store_id !== undefined) { updates.push('store_id = ?'); values.push(store_id); }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(destId);
    
    await pool.query(`UPDATE destinations SET ${updates.join(', ')} WHERE id = ?`, values);
    
    const [updated] = await pool.query('SELECT * FROM destinations WHERE id = ?', [destId]);
    
    res.json(updated[0]);
  } catch (error) {
    console.error('Error al actualizar destino:', error);
    res.status(500).json({ error: 'Error al actualizar destino', detail: error.message });
  }
});

app.delete('/api/destinations/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM destinations WHERE id = ?', [req.params.id]);
    res.json({ message: 'Destino eliminado exitosamente' });
  } catch (error) {
    console.error('Error al eliminar destino:', error);
    res.status(500).json({ error: 'Error al eliminar destino', detail: error.message });
  }
});

// ============= ENDPOINT DE TRANSACCIONES (Multi-tienda) =============

app.post('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const { cart } = req.body;
    
    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío' });
    }
    
    // Determinar la tienda del usuario
    let storeId = req.user.store_id;
    
    // Si es admin sin tienda asignada, no puede hacer ventas
    if (!storeId) {
      return res.status(400).json({ error: 'Usuario sin tienda asignada' });
    }
    
    // Obtener destinos activos de ESTA tienda específica
    const [destinations] = await pool.query(
      'SELECT * FROM destinations WHERE active = TRUE AND store_id = ?',
      [storeId]
    );
    
    if (destinations.length === 0) {
      return res.status(400).json({ 
        error: 'No hay destinos activos configurados para esta tienda',
        store_id: storeId,
        store_name: req.user.store_name
      });
    }
    
    const total = cart.reduce((sum, item) => sum + (item.value * item.quantity), 0);
    const productsString = cart.map(item => `${item.name} (x${item.quantity})`).join('|');
    
    const timestamp = Date.now();
    
    const results = [];
    let successCount = 0;
    let failCount = 0;
    
    console.log(`\n🏪 Procesando venta para tienda: ${req.user.store_name} (ID: ${storeId})`);
    console.log(`📦 Productos: ${productsString}`);
    console.log(`💰 Total: ${total.toLocaleString('es-CL')} CLP`);
    console.log(`📡 Enviando a ${destinations.length} destino(s)...\n`);
    
    for (const dest of destinations) {
      try {
        const webhookUrl = dest.server.includes('74.208.102.210:3006')
          ? `${dest.server}/${dest.webhook_id}`
          : `${dest.server}/api/v1/public/pos/${dest.webhook_id}/http`;
        
        console.log(`  → Enviando a: ${dest.name} (${webhookUrl})`);
        
        const payload = {
          type: "data",
          id: timestamp.toString(),
          register_id: dest.register_id,
          messages: [{
            timestamp: timestamp,
            msg_id: timestamp.toString(),
            data: productsString,
            value: total.toString(),
            currency: "CLP"
          }]
        };
        
        const response = await axios.post(webhookUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${dest.secret}`
          },
          timeout: 10000
        });
        
        if (response.status === 200) {
          successCount++;
          results.push({ 
            destination: dest.name, 
            status: 'success', 
            code: response.status,
            store_id: storeId,
            store_name: req.user.store_name
          });
          console.log(`    ✅ Éxito en ${dest.name}`);
        } else {
          failCount++;
          results.push({ 
            destination: dest.name, 
            status: 'failed', 
            code: response.status,
            store_id: storeId,
            store_name: req.user.store_name
          });
          console.log(`    ❌ Fallo en ${dest.name} (código ${response.status})`);
        }
        
      } catch (error) {
        failCount++;
        results.push({ 
          destination: dest.name, 
          status: 'error', 
          error: error.message,
          store_id: storeId,
          store_name: req.user.store_name
        });
        console.log(`    ❌ Error en ${dest.name}: ${error.message}`);
      }
    }
    
    const status = successCount > 0 && failCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'failed');
    
    // Guardar transacción con store_id
    const [result] = await pool.query(
      'INSERT INTO transactions (user_id, store_id, timestamp, products_data, total_value, currency, status, details) VALUES (?, ?, NOW(), ?, ?, ?, ?, ?)',
      [req.user.id, storeId, productsString, total, 'CLP', status, JSON.stringify(results)]
    );
    
    console.log(`\n✅ Transacción registrada (ID: ${result.insertId})`);
    console.log(`📊 Resultado: ${successCount} éxito(s), ${failCount} fallo(s)\n`);
    
    res.json({
      success_count: successCount,
      fail_count: failCount,
      total: total,
      results: results,
      transaction_id: result.insertId,
      store_id: storeId,
      store_name: req.user.store_name
    });
    
  } catch (error) {
    console.error('Error al enviar transacción:', error);
    res.status(500).json({ error: 'Error al enviar transacción', detail: error.message });
  }
});

// Obtener historial de transacciones (filtrado por tienda)
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    let query = `
      SELECT t.*, u.username, u.full_name, s.name as store_name, s.code as store_code
      FROM transactions t 
      JOIN users u ON t.user_id = u.id
      JOIN stores s ON t.store_id = s.id
    `;
    
    let params = [];
    
    // Si es vendedor, solo ver transacciones de su tienda
    if (req.user.role === 'vendedor' && req.user.store_id) {
      query += ' WHERE t.store_id = ?';
      params.push(req.user.store_id);
    }
    
    query += ' ORDER BY t.id DESC LIMIT ?';
    params.push(limit);
    
    const [transactions] = await pool.query(query, params);
    
    res.json(transactions);
  } catch (error) {
    console.error('Error al obtener transacciones:', error);
    res.status(500).json({ error: 'Error al obtener transacciones', detail: error.message });
  }
});

// Estadísticas por tienda
app.get('/api/stats/store/:storeId?', authenticateToken, async (req, res) => {
  try {
    let storeId = req.params.storeId;
    
    // Si es vendedor, solo puede ver stats de su tienda
    if (req.user.role === 'vendedor') {
      storeId = req.user.store_id;
    }
    
    // Si no se especifica tienda y es admin, mostrar todas
    if (!storeId && req.user.role === 'admin') {
      const [allStores] = await pool.query(`
        SELECT 
          s.id,
          s.name,
          s.code,
          COUNT(DISTINCT t.id) as total_transactions,
          COALESCE(SUM(t.total_value), 0) as total_sales,
          COUNT(DISTINCT p.id) as total_products,
          COUNT(DISTINCT d.id) as total_destinations
        FROM stores s
        LEFT JOIN transactions t ON s.id = t.store_id AND DATE(t.timestamp) = CURDATE()
        LEFT JOIN products p ON s.id = p.store_id
        LEFT JOIN destinations d ON s.id = d.store_id AND d.active = TRUE
        GROUP BY s.id
        ORDER BY s.name
      `);
      
      return res.json({ stores: allStores });
    }
    
    // Estadísticas de una tienda específica
    const [storeStats] = await pool.query(`
      SELECT 
        s.id,
        s.name,
        s.code,
        s.active,
        COUNT(DISTINCT CASE WHEN DATE(t.timestamp) = CURDATE() THEN t.id END) as transactions_today,
        COALESCE(SUM(CASE WHEN DATE(t.timestamp) = CURDATE() THEN t.total_value END), 0) as sales_today,
        COUNT(DISTINCT CASE WHEN DATE(t.timestamp) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN t.id END) as transactions_week,
        COALESCE(SUM(CASE WHEN DATE(t.timestamp) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN t.total_value END), 0) as sales_week,
        COUNT(DISTINCT t.id) as transactions_total,
        COALESCE(SUM(t.total_value), 0) as sales_total,
        COUNT(DISTINCT p.id) as total_products,
        COUNT(DISTINCT d.id) as total_destinations_active,
        COUNT(DISTINCT u.id) as total_users
      FROM stores s
      LEFT JOIN transactions t ON s.id = t.store_id
      LEFT JOIN products p ON s.id = p.store_id
      LEFT JOIN destinations d ON s.id = d.store_id AND d.active = TRUE
      LEFT JOIN users u ON s.id = u.store_id AND u.active = TRUE
      WHERE s.id = ?
      GROUP BY s.id
    `, [storeId]);
    
    if (storeStats.length === 0) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }
    
    res.json(storeStats[0]);
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas', detail: error.message });
  }
});

// ============= ENDPOINTS DE SALUD =============

app.get('/', (req, res) => {
  res.json({
    message: 'POS System API Multi-Tienda',
    version: '3.0.0',
    status: 'running',
    features: [
      'Multi-store support',
      'Store-specific destinations',
      'Store-specific products',
      'JWT Authentication',
      'Role-based access control'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Endpoint de información (sin autenticación para demo)
app.get('/api/info', async (req, res) => {
  try {
    const [stores] = await pool.query('SELECT COUNT(*) as count FROM stores WHERE active = TRUE');
    const [users] = await pool.query('SELECT COUNT(*) as count FROM users WHERE active = TRUE');
    const [products] = await pool.query('SELECT COUNT(*) as count FROM products');
    const [transactions] = await pool.query('SELECT COUNT(*) as count FROM transactions WHERE DATE(timestamp) = CURDATE()');
    
    res.json({
      system: 'POS Multi-Tienda',
      version: '3.0.0',
      active_stores: stores[0].count,
      active_users: users[0].count,
      total_products: products[0].count,
      transactions_today: transactions[0].count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      system: 'POS Multi-Tienda',
      version: '3.0.0',
      status: 'running'
    });
  }
});

// Iniciar servidor
async function startServer() {
  await initDatabase();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor POS Multi-Tienda iniciado`);
    console.log(`📡 URL: http://0.0.0.0:${PORT}`);
    console.log(`📚 Info: http://localhost:${PORT}/api/info`);
    console.log(`\n🏪 Sistema Multi-Tienda:`);
    console.log(`   - Cada tienda tiene sus propios destinos`);
    console.log(`   - Cada tienda tiene sus propios productos`);
    console.log(`   - Vendedores asignados a tiendas específicas`);
    console.log(`\n👤 Usuario por defecto: admin / admin123`);
    console.log(`⚠️  IMPORTANTE: Crear tiendas y asignar usuarios\n`);
  });
}

startServer().catch(error => {
  console.error('Error fatal al iniciar el servidor:', error);
  process.exit(1);
});