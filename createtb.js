const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'inventario_ina',
});

const crearTablas = async () => {
  try {
    // Crear tabla categorias
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categorias (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL
      );
    `);

    // Crear tabla ubicaciones
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ubicaciones (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL
      );
    `);

    // Crear tabla componentes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS componentes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        descripcion TEXT,
        cantidad INTEGER DEFAULT 0,
        tipo INTEGER REFERENCES categorias(id),
        ubicacion INTEGER REFERENCES ubicaciones(id),
        estado VARCHAR(50),
        imagen VARCHAR(255),
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Crear tabla historial
    await pool.query(`
      CREATE TABLE IF NOT EXISTS historial (
        id SERIAL PRIMARY KEY,
        componente_id INTEGER REFERENCES componentes(id),
        movimiento TEXT,
        cantidad INTEGER,
        persona TEXT,
        observaciones TEXT,
        fecha TIMESTAMP DEFAULT now()
      );
    `);
// crea tabla usuarios
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        usuario TEXT UNIQUE NOT NULL,
        contrasena TEXT NOT NULL,
        rol TEXT NOT NULL CHECK (rol IN ('docente', 'estudiante'))
      );
    `);

console.log("✅ Tablas creadas correctamente.");

    // Verificar si ya existe el usuario admin
    const res = await pool.query(
      "SELECT * FROM usuarios WHERE usuario = $1",
      ['admin']
    );

    if (res.rows.length === 0) {
      // Insertar usuario admin
      await pool.query(
        "INSERT INTO usuarios (nombre, usuario, contrasena, rol) VALUES ($1, $2, $3, $4)",
        ['Administrador', 'admin', '1234', 'docente'] // Cambia la contraseña aquí si quieres
      );
      console.log("✅ Usuario admin creado.");
    } else {
      console.log("ℹ️ Usuario admin ya existe.");
    }

  } catch (err) {
    console.error("❌ Error creando las tablas o usuario:", err);
  } finally {
    await pool.end();
  }
};

crearTablas();

