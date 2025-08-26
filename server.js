const express = require('express');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configurar Cloudinary con variables de entorno
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Conexión a PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'inventario_ina',
});

// Middleware y configuración
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'servidor')));

// Configurar sesiones
app.use(session({
  secret: 'clave_super_secreta',
  resave: false,
  saveUninitialized: false,
}));

// Multer: almacenar en memoria para luego subir a Cloudinary
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware para verificar si está autenticado
function checkAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Middleware para control de rol
function checkRole(role) {
  return (req, res, next) => {
    if (req.session.user && req.session.user.rol === role) {
      next();
    } else {
      res.status(403).send('Acceso denegado');
    }
  };
}

// Función para extraer public_id de Cloudinary desde la URL
function getPublicIdFromUrl(url) {
  if (!url) return null;
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    let publicIdWithExtension = parts[1];
    const lastDot = publicIdWithExtension.lastIndexOf('.');
    if (lastDot === -1) return publicIdWithExtension;
    return publicIdWithExtension.substring(0, lastDot);
  } catch {
    return null;
  }
}

// =================== LOGIN Y LOGOUT ===================
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { usuario, contrasena } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE usuario = $1 AND contrasena = $2',
      [usuario, contrasena]
    );
    if (result.rows.length > 0) {
      req.session.user = {
        id: result.rows[0].id,
        nombre: result.rows[0].nombre,
        usuario: result.rows[0].usuario,
        rol: result.rows[0].rol
      };
      res.redirect('/');
    } else {
      res.render('login', { error: 'Usuario o contraseña incorrectos' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Error en el servidor');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Proteger todas las rutas excepto login/logout
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  checkAuth(req, res, next);
});

// =================== MENÚ PRINCIPAL ===================
app.get('/', (req, res) => {
  res.render('menu', { user: req.session.user });
});

// =================== GESTIÓN DE USUARIOS (solo docente) ===================

// Mostrar todos los usuarios
app.get('/usuarios', checkRole('docente'), async (req, res) => {
  try {
    const usuarios = await pool.query('SELECT id, nombre, usuario, rol FROM usuarios ORDER BY id');
    res.render('usuarios', { 
      usuarios: usuarios.rows, 
      user: req.session.user, 
      error: null, 
      mensaje: null 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar usuarios');
  }
});

// Registrar nuevo usuario
app.post('/usuarios', checkRole('docente'), async (req, res) => {
  const { nombre, usuario, contrasena, rol } = req.body;
  try {
    await pool.query(
      'INSERT INTO usuarios (nombre, usuario, contrasena, rol) VALUES ($1, $2, $3, $4)',
      [nombre, usuario, contrasena, rol]
    );

    const usuarios = await pool.query('SELECT id, nombre, usuario, rol FROM usuarios ORDER BY id');
    res.render('usuarios', { 
      usuarios: usuarios.rows, 
      user: req.session.user, 
      error: null, 
      success: '✅ Usuario registrado exitosamente' 
    });

  } catch (err) {
    console.error(err);
    const usuarios = await pool.query('SELECT id, nombre, usuario, rol FROM usuarios ORDER BY id');
    res.render('usuarios', { 
      usuarios: usuarios.rows, 
      user: req.session.user, 
      error: '⚠️ Error: el usuario ya existe', 
      success: null 
    });
  }
});

// Eliminar usuario
app.post('/usuarios/eliminar/:id', checkRole('docente'), async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    const usuarios = await pool.query('SELECT id, nombre, usuario, rol FROM usuarios ORDER BY id');
    res.render('usuarios', { 
      usuarios: usuarios.rows, 
      user: req.session.user, 
      error: null, 
      success: '✅ Usuario eliminado exitosamente' 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al eliminar usuario');
  }
});



// =================== INVENTARIO ===================
app.get('/inventario', async (req, res) => {
  try {
    const { busqueda, tipo } = req.query;
    let query = `
      SELECT c.id, c.nombre, c.descripcion, c.cantidad, c.estado, c.imagen,
             cat.nombre AS tipo_nombre,
             ubi.nombre AS ubicacion_nombre
      FROM componentes c
      LEFT JOIN categorias cat ON c.tipo = cat.id
      LEFT JOIN ubicaciones ubi ON c.ubicacion = ubi.id
      WHERE 1=1
    `;
    const valores = [];
    let index = 1;
    if (busqueda) {
      query += ` AND LOWER(c.nombre) LIKE LOWER($${index++})`;
      valores.push(`%${busqueda}%`);
    }
    if (tipo) {
      query += ` AND c.tipo = $${index++}`;
      valores.push(tipo);
    }
    query += ` ORDER BY c.id`;
    const result = await pool.query(query, valores);
    const categorias = await pool.query('SELECT * FROM categorias');
    res.render('inventario', {
      componentes: result.rows,
      categorias: categorias.rows,
      user: req.session.user,
      busqueda: busqueda || '',
      tipo: tipo || ''
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar inventario');
  }
});

// =================== CRUD COMPONENTES (solo docente) ===================
app.get('/registro', checkRole('docente'), async (req, res) => {
  try {
    const categorias = await pool.query('SELECT * FROM categorias ORDER BY nombre');
    const ubicaciones = await pool.query('SELECT * FROM ubicaciones ORDER BY nombre');
    res.render('registro', { 
      categorias: categorias.rows, 
      ubicaciones: ubicaciones.rows, 
      user: req.session.user,
      success: null,
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar formulario de registro');
  }
});

app.post('/agregar', checkRole('docente'), upload.single('imagen'), async (req, res) => {
  const { nombre, descripcion, cantidad, tipo, ubicacion, estado } = req.body;
  try {
    let imagenUrl = null;

    if (req.file) {
      imagenUrl = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'inventario' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        stream.end(req.file.buffer);
      });
    }

    await pool.query(
      `INSERT INTO componentes (nombre, descripcion, cantidad, tipo, ubicacion, estado, imagen)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [nombre, descripcion, cantidad, tipo, ubicacion, estado, imagenUrl]
    );

    const categorias = await pool.query('SELECT * FROM categorias ORDER BY nombre');
    const ubicaciones = await pool.query('SELECT * FROM ubicaciones ORDER BY nombre');

    res.render('registro', { 
      categorias: categorias.rows, 
      ubicaciones: ubicaciones.rows, 
      user: req.session.user,
      success: '✅ Componente registrado exitosamente',
      error: null
    });

  } catch (err) {
    console.error(err);

    const categorias = await pool.query('SELECT * FROM categorias ORDER BY nombre');
    const ubicaciones = await pool.query('SELECT * FROM ubicaciones ORDER BY nombre');

    res.render('registro', { 
      categorias: categorias.rows, 
      ubicaciones: ubicaciones.rows, 
      user: req.session.user,
      success: null,
      error: '⚠️ Error al registrar componente'
    });
  }
});


app.get('/editar/:id', checkRole('docente'), async (req, res) => {
  try {
    const id = req.params.id;
    const compRes = await pool.query('SELECT * FROM componentes WHERE id = $1', [id]);
    const categorias = await pool.query('SELECT * FROM categorias ORDER BY nombre');
    const ubicaciones = await pool.query('SELECT * FROM ubicaciones ORDER BY nombre');
    if (compRes.rows.length === 0) return res.status(404).send('Componente no encontrado');
    res.render('editar', { 
      componente: compRes.rows[0], 
      categorias: categorias.rows, 
      ubicaciones: ubicaciones.rows,
      user: req.session.user
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar componente');
  }
});

app.post('/editar/:id', checkRole('docente'), upload.single('imagen'), async (req, res) => {
  const id = req.params.id;
  const { nombre, descripcion, cantidad, tipo, ubicacion, estado } = req.body;
  try {
    let imagenUrl;
    if (req.file) {
      imagenUrl = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'inventario' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        stream.end(req.file.buffer);
      });
    }

    let query, params;
    if (imagenUrl) {
      query = `UPDATE componentes SET nombre=$1, descripcion=$2, cantidad=$3, tipo=$4, ubicacion=$5, estado=$6, imagen=$7 WHERE id=$8`;
      params = [nombre, descripcion, cantidad, tipo, ubicacion, estado, imagenUrl, id];
    } else {
      query = `UPDATE componentes SET nombre=$1, descripcion=$2, cantidad=$3, tipo=$4, ubicacion=$5, estado=$6 WHERE id=$7`;
      params = [nombre, descripcion, cantidad, tipo, ubicacion, estado, id];
    }

    await pool.query(query, params);
    res.redirect('/inventario');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al actualizar componente');
  }
});

// =================== ELIMINAR COMPONENTE Y SU IMAGEN EN CLOUDINARY ===================
function getPublicIdFromUrl(url) {
  if (!url) return null;
  const parts = url.split('/');
  const filename = parts.pop();
  const uploadIndex = parts.indexOf('upload');
  if (uploadIndex === -1) return null;
  const folderParts = parts.slice(uploadIndex + 1);
  const folder = folderParts.join('/');
  const publicId = folder ? `${folder}/${filename}` : filename;
  return publicId.replace(/\.[^/.]+$/, "");
}

app.get('/eliminar/:id', checkRole('docente'), async (req, res) => {
  try {
    const id = req.params.id;

    // Eliminar historial relacionado
    await pool.query('DELETE FROM historial WHERE componente_id = $1', [id]);

    // Obtener URL de la imagen antes de borrar el componente
    const compRes = await pool.query('SELECT imagen FROM componentes WHERE id = $1', [id]);
    if (compRes.rows.length > 0 && compRes.rows[0].imagen) {
      const publicId = getPublicIdFromUrl(compRes.rows[0].imagen);
      console.log('PublicId a eliminar en Cloudinary:', publicId); // Para depurar
      if (publicId) {
        await cloudinary.uploader.destroy(publicId);
      }
    }

    // Eliminar componente
    await pool.query('DELETE FROM componentes WHERE id = $1', [id]);

    res.redirect('/inventario');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al eliminar componente');
  }
});





// =================== CATEGORÍAS Y UBICACIONES ===================
app.get('/categorias_ubicaciones', async (req, res) => {
  try {
    const categoria = req.query.categoria || '';
    const ubicacion = req.query.ubicacion || '';
    const categoriasRes = await pool.query('SELECT * FROM categorias ORDER BY nombre');
    const ubicacionesRes = await pool.query('SELECT * FROM ubicaciones ORDER BY nombre');
    let query = `
      SELECT c.id, c.nombre, c.descripcion, c.cantidad,
             cat.nombre AS categoria_nombre,
             ubi.nombre AS ubicacion_nombre
      FROM componentes c
      LEFT JOIN categorias cat ON c.tipo = cat.id
      LEFT JOIN ubicaciones ubi ON c.ubicacion = ubi.id
      WHERE 1=1
    `;
    const valores = [];
    let idx = 1;
    if (categoria) {
      query += ` AND c.tipo = $${idx++}`;
      valores.push(categoria);
    }
    if (ubicacion) {
      query += ` AND c.ubicacion = $${idx++}`;
      valores.push(ubicacion);
    }
    query += ' ORDER BY c.nombre';
    const componentesRes = await pool.query(query, valores);
    res.render('categorias_ubicaciones', {
      categorias: categoriasRes.rows,
      ubicaciones: ubicacionesRes.rows,
      componentes: componentesRes.rows,
      categoria,
      ubicacion,
      user: req.session.user
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al cargar categorías, ubicaciones y componentes');
  }
});

app.post('/categorias_ubicaciones/categorias', checkRole('docente'), async (req, res) => {
  try {
    const { nombre } = req.body;
    await pool.query('INSERT INTO categorias (nombre) VALUES ($1)', [nombre]);
    res.redirect('/categorias_ubicaciones');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al crear categoría');
  }
});

app.post('/categorias_ubicaciones/ubicaciones', checkRole('docente'), async (req, res) => {
  try {
    const { nombre } = req.body;
    await pool.query('INSERT INTO ubicaciones (nombre) VALUES ($1)', [nombre]);
    res.redirect('/categorias_ubicaciones');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al crear ubicación');
  }
});

app.post('/categorias_ubicaciones/categorias/eliminar/:id', checkRole('docente'), async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
    res.redirect('/categorias_ubicaciones');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al eliminar categoría');
  }
});

app.post('/categorias_ubicaciones/ubicaciones/eliminar/:id', checkRole('docente'), async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM ubicaciones WHERE id = $1', [id]);
    res.redirect('/categorias_ubicaciones');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al eliminar ubicación');
  }
});

app.post('/categorias_ubicaciones/categorias/editar/:id', checkRole('docente'), async (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;
  await pool.query('UPDATE categorias SET nombre=$1 WHERE id=$2', [nombre, id]);
  res.redirect('/categorias_ubicaciones');
});

app.post('/categorias_ubicaciones/ubicaciones/editar/:id', checkRole('docente'), async (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;
  await pool.query('UPDATE ubicaciones SET nombre=$1 WHERE id=$2', [nombre, id]);
  res.redirect('/categorias_ubicaciones');
});





// =================== HISTORIAL ===================

// RUTA: Mostrar historial (general o desde un componente)
app.get('/historial', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.redirect('/login');

    const movimientosResult = await pool.query(`
      SELECT h.id, h.componente_id, c.nombre AS componente_nombre,
             h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
      FROM historial h
      JOIN componentes c ON h.componente_id = c.id
      ORDER BY h.fecha DESC
    `);
    const movimientos = movimientosResult.rows;

    const usuariosResult = await pool.query('SELECT nombre, rol FROM usuarios');
    const usuarios = usuariosResult.rows;

    const componentesResult = await pool.query('SELECT id, nombre FROM componentes');
    const componentes = componentesResult.rows;

    const componenteID = req.query.id || null;
    const componenteNombre = req.query.nombre || null;

    res.render('historial', {
      user,
      movimientos,
      usuarios,
      componentes,
      componenteID,
      componenteNombre,
      error: null
    });

  } catch (error) {
    console.error(error);
    res.render('historial', { 
      user: req.session.user, 
      movimientos: [], 
      usuarios: [], 
      componentes: [], 
      componenteID: null, 
      componenteNombre: null,
      error: "⚠️ Error al cargar historial"
    });
  }
});

// RUTA: Registrar nuevo movimiento
app.post('/historial', async (req, res) => {
  try {
    const { componente_id, movimiento, cantidad, persona, observaciones } = req.body;
    const user = req.session.user;
    if (!user || user.rol !== 'docente') return res.status(403).send("No autorizado");

    // Verificar que la persona exista como usuario registrado
    if (persona) {
      const usuarioResult = await pool.query(
        'SELECT nombre FROM usuarios WHERE nombre = $1',
        [persona]
      );
      if (usuarioResult.rowCount === 0) {
        // Mostrar historial con mensaje de error
        const movimientosResult = await pool.query(`
          SELECT h.id, h.componente_id, c.nombre AS componente_nombre,
                 h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
          FROM historial h
          JOIN componentes c ON h.componente_id = c.id
          ORDER BY h.fecha DESC
        `);
        const movimientos = movimientosResult.rows;

        const usuariosResult = await pool.query('SELECT nombre, rol FROM usuarios');
        const usuarios = usuariosResult.rows;

        const componentesResult = await pool.query('SELECT id, nombre FROM componentes');
        const componentes = componentesResult.rows;

        return res.render('historial', {
          user,
          movimientos,
          usuarios,
          componentes,
          componenteID: componente_id,
          componenteNombre: null,
          error: "⚠️ La persona indicada no está registrada como usuario"
        });
      }
    }

    const cantidadNum = parseInt(cantidad);
    if (isNaN(cantidadNum) || cantidadNum <= 0) return res.send("Cantidad inválida");

    const componenteResult = await pool.query(
      'SELECT cantidad, nombre FROM componentes WHERE id = $1',
      [componente_id]
    );
    if (componenteResult.rowCount === 0) return res.send("Componente no encontrado");

    let nuevaCantidad = componenteResult.rows[0].cantidad;
    const tipo = movimiento.toLowerCase();
    const nombreComponente = componenteResult.rows[0].nombre;

    // CONTROL DE STOCK
    if (tipo === 'préstamo' || tipo === 'salida') {
      if (cantidadNum > nuevaCantidad) {
        const movimientosResult = await pool.query(`
          SELECT h.id, h.componente_id, c.nombre AS componente_nombre,
                 h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
          FROM historial h
          JOIN componentes c ON h.componente_id = c.id
          ORDER BY h.fecha DESC
        `);
        const movimientos = movimientosResult.rows;

        const usuariosResult = await pool.query('SELECT nombre, rol FROM usuarios');
        const usuarios = usuariosResult.rows;

        const componentesResult = await pool.query('SELECT id, nombre FROM componentes');
        const componentes = componentesResult.rows;

        return res.render('historial', {
          user,
          movimientos,
          usuarios,
          componentes,
          componenteID: componente_id,
          componenteNombre: nombreComponente,
          error: "⚠️ No hay suficiente stock disponible para realizar este movimiento."
        });
      }
      nuevaCantidad -= cantidadNum;
    } else if (tipo === 'devolución' || tipo === 'ingreso') {
      nuevaCantidad += cantidadNum;
    } else {
      return res.send("Tipo de movimiento inválido");
    }

    await pool.query('UPDATE componentes SET cantidad = $1 WHERE id = $2', [nuevaCantidad, componente_id]);

    await pool.query(`
      INSERT INTO historial (componente_id, movimiento, cantidad, persona, observaciones, fecha)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [componente_id, movimiento, cantidadNum, persona || null, observaciones || null]);

    res.redirect('/historial');

  } catch (err) {
    console.error(err);
    const movimientosResult = await pool.query(`
      SELECT h.id, h.componente_id, c.nombre AS componente_nombre,
             h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
      FROM historial h
      JOIN componentes c ON h.componente_id = c.id
      ORDER BY h.fecha DESC
    `);
    const movimientos = movimientosResult.rows;

    const usuariosResult = await pool.query('SELECT nombre, rol FROM usuarios');
    const usuarios = usuariosResult.rows;

    const componentesResult = await pool.query('SELECT id, nombre FROM componentes');
    const componentes = componentesResult.rows;

    res.render('historial', {
      user: req.session.user,
      movimientos,
      usuarios,
      componentes,
      componenteID: null,
      componenteNombre: null,
      error: "⚠️ Error al registrar movimiento"
    });
  }
});

// RUTA: Buscar historial por persona
app.get('/historial/buscar', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.redirect('/login');

    const { persona } = req.query;

    const movimientosResult = await pool.query(`
      SELECT h.id, h.componente_id, c.nombre as componente_nombre,
             h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
      FROM historial h
      JOIN componentes c ON h.componente_id = c.id
      WHERE h.persona ILIKE $1
      ORDER BY h.fecha DESC
    `, [`%${persona}%`]);
    const movimientos = movimientosResult.rows;

    const usuariosResult = await pool.query('SELECT nombre, rol FROM usuarios');
    const usuarios = usuariosResult.rows;

    const componentesResult = await pool.query('SELECT id, nombre FROM componentes');
    const componentes = componentesResult.rows;

    res.render('historial', {
      user,
      movimientos,
      usuarios,
      componentes,
      componenteID: null,
      componenteNombre: null,
      error: null
    });

  } catch (err) {
    console.error(err);
    res.render('historial', {
      user: req.session.user,
      movimientos: [],
      usuarios: [],
      componentes: [],
      componenteID: null,
      componenteNombre: null,
      error: "⚠️ Error al buscar movimientos"
    });
  }
});

// Registrar devolución desde modal
app.post('/historial/devolver', async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || user.rol !== 'docente') return res.status(403).send("No autorizado");

    const { prestamo_id, observaciones } = req.body;

    const prestamoResult = await pool.query(
      `SELECT componente_id, cantidad, persona FROM historial WHERE id = $1`,
      [prestamo_id]
    );
    if (prestamoResult.rowCount === 0) return res.send("Préstamo no encontrado");

    const prestamo = prestamoResult.rows[0];

    await pool.query(
      'UPDATE componentes SET cantidad = cantidad + $1 WHERE id = $2',
      [prestamo.cantidad, prestamo.componente_id]
    );

    await pool.query(
      `INSERT INTO historial (componente_id, movimiento, cantidad, persona, observaciones, fecha)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [prestamo.componente_id, 'devolución', prestamo.cantidad, prestamo.persona, observaciones]
    );

    res.redirect('/historial');

  } catch (err) {
    console.error(err);
    res.send("Error al registrar devolución");
  }
});







// =================== CONTACTO ===================
app.get('/contacto', (req, res) => {
  res.render('contacto', { user: req.session.user, mensaje: null, tipo: null });
});

app.post('/contacto', async (req, res) => {
  const { nombre, correo, mensaje } = req.body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.CORREO_DOCENTE,
      pass: process.env.CORREO_PASSWORD
    }
  });

  const mailOptions = {
    from: `"${nombre}" <${process.env.CORREO_DOCENTE}>`, // Gmail requiere tu cuenta real
    to: process.env.CORREO_DOCENTE,
    subject: `Mensaje de ${nombre} desde Inventario INA`,
    text: `Nombre: ${nombre}\nCorreo del estudiante: ${correo}\nMensaje:\n${mensaje}`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.render('contacto', { user: req.session.user, mensaje: 'Mensaje enviado correctamente', tipo: 'success' });
  } catch (err) {
    console.error(err);
    res.render('contacto', { user: req.session.user, mensaje: 'Error al enviar el mensaje', tipo: 'error' });
  }
});

// =================== REPORTES ===================
app.get('/reportes', async (req, res) => {
  if (!req.session.user || req.session.user.rol !== 'docente') {
    return res.redirect('/');
  }

  try {
    const categoriasRes = await pool.query('SELECT * FROM categorias ORDER BY nombre');
    const ubicacionesRes = await pool.query('SELECT * FROM ubicaciones ORDER BY nombre');

    const { categoria, ubicacion } = req.query;

    let query = `
      SELECT c.id, c.nombre, c.cantidad, cat.nombre AS categoria, u.nombre AS ubicacion
      FROM componentes c
      LEFT JOIN categorias cat ON c.tipo = cat.id
      LEFT JOIN ubicaciones u ON c.ubicacion = u.id
      WHERE 1=1
    `;
    const params = [];

    if (categoria) {
      params.push(categoria);
      query += ` AND c.tipo = $${params.length}`;
    }

    if (ubicacion) {
      params.push(ubicacion);
      query += ` AND c.ubicacion = $${params.length}`;
    }

    query += ' ORDER BY c.nombre';

    const componentesRes = await pool.query(query, params);

    res.render('reportes', {
      user: req.session.user,
      categorias: categoriasRes.rows,
      ubicaciones: ubicacionesRes.rows,
      componentes: componentesRes.rows,
      filtroCategoria: categoria || '',
      filtroUbicacion: ubicacion || ''
    });
  } catch (err) {
    console.error(err);
    res.send('Error cargando los reportes');
  }
});

// =================== REPORTE EXCEL COMPONENTES ===================
app.get('/reportes/export/excel', async (req, res) => {
  if (!req.session.user || req.session.user.rol !== 'docente') return res.redirect('/');

  const { categoria, ubicacion } = req.query;

  try {
    // Consulta filtrada
    let query = `
      SELECT c.nombre AS nombre, cat.nombre AS categoria, u.nombre AS ubicacion, c.cantidad
      FROM componentes c
      LEFT JOIN categorias cat ON c.tipo = cat.id
      LEFT JOIN ubicaciones u ON c.ubicacion = u.id
      WHERE 1=1
    `;
    const params = [];
    if (categoria) { params.push(categoria); query += ` AND c.tipo = $${params.length}`; }
    if (ubicacion) { params.push(ubicacion); query += ` AND c.ubicacion = $${params.length}`; }

    const result = await pool.query(query, params);

    // Crear workbook
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Componentes');

    // Columnas con ancho definido
    sheet.columns = [
      { header: 'Nombre', key: 'nombre', width: 30 },
      { header: 'Categoría', key: 'categoria', width: 25 },
      { header: 'Ubicación', key: 'ubicacion', width: 25 },
      { header: 'Cantidad', key: 'cantidad', width: 10 }
    ];

    // Agregar filas
    result.rows.forEach(row => sheet.addRow({
      nombre: row.nombre || '',
      categoria: row.categoria || 'Sin categoría',
      ubicacion: row.ubicacion || 'Sin ubicación',
      cantidad: row.cantidad != null ? row.cantidad : 0
    }));

    // Encabezados en negrita
    sheet.getRow(1).font = { bold: true };

    // Configurar respuesta para descarga
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=componentes.xlsx`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("Error generando Excel de componentes:", err);
    res.status(500).send("Error generando Excel de componentes");
  }
});

// =================== REPORTE PDF COMPONENTES ===================
app.get('/reportes/export/pdf', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.nombre AS componente, cat.nombre AS categoria, u.nombre AS ubicacion, c.cantidad
      FROM componentes c
      LEFT JOIN categorias cat ON c.tipo = cat.id
      LEFT JOIN ubicaciones u ON c.ubicacion = u.id
      ORDER BY cat.nombre, c.nombre
    `);

    const componentes = result.rows;

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 30, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=componentes.pdf`);
    doc.pipe(res);

    // Título
    doc.fontSize(16).text('Reporte de Componentes', { align: 'center' });
    doc.moveDown();

    // Encabezados de tabla
    const headers = ['Nombre', 'Categoría', 'Ubicación', 'Cantidad'];
    const colWidths = [150, 120, 180, 60];
    let x = doc.page.margins.left;
    let y = doc.y;

    doc.font('Helvetica-Bold').fontSize(10);
    headers.forEach((h, i) => {
      doc.text(h, x, y, { width: colWidths[i], align: 'left' });
      x += colWidths[i];
    });
    doc.moveDown(0.5);

    // Línea separadora
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
    doc.moveDown(0.5);

    // Filas de tabla
    doc.font('Helvetica').fontSize(10);
    componentes.forEach(comp => {
      x = doc.page.margins.left;
      y = doc.y;

      const values = [
        comp.componente || '',
        comp.categoria || 'Sin categoría',
        comp.ubicacion || 'Sin ubicación',
        comp.cantidad != null ? comp.cantidad.toString() : '0'
      ];

      values.forEach((val, i) => {
        doc.text(val, x, y, { width: colWidths[i], align: 'left' });
        x += colWidths[i];
      });

      doc.moveDown(0.5);

      // Salto de página si estamos al final
      if (doc.y > doc.page.height - 50) {
        doc.addPage();
      }
    });

    doc.end();

  } catch (err) {
    console.error('Error al generar el PDF de componentes:', err);
    res.status(500).send('Error al generar el reporte PDF de componentes');
  }
});


// Reporte de Historial - Excel
app.get('/reportes/historial/excel', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT h.id, c.nombre AS componente, h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
      FROM historial h
      JOIN componentes c ON h.componente_id = c.id
      ORDER BY h.fecha DESC
    `);

    const historial = result.rows;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Historial");

    worksheet.columns = [
      { header: "ID", key: "id", width: 5 },
      { header: "Componente", key: "componente", width: 25 },
      { header: "Movimiento", key: "movimiento", width: 15 },
      { header: "Cantidad", key: "cantidad", width: 10 },
      { header: "Persona", key: "persona", width: 20 },
      { header: "Observaciones", key: "observaciones", width: 30 },
      { header: "Fecha", key: "fecha", width: 20 }
    ];

    historial.forEach(row => worksheet.addRow(row));

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=historial.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generando Excel de historial:", err);
    res.status(500).send("Error generando Excel");
  }
});


// Reporte de Historial - PDF
app.get('/reportes/historial/pdf', async (req, res) => {
  try {
    const { fechaDesde = '', fechaHasta = '', personaFiltro = '' } = req.query;

    let query = `
      SELECT h.id, c.nombre AS componente, h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
      FROM historial h
      JOIN componentes c ON h.componente_id = c.id
      WHERE 1=1
    `;
    const params = [];
    let i = 1;

    if (fechaDesde) {
      query += ` AND h.fecha >= $${i++}`;
      params.push(fechaDesde);
    }
    if (fechaHasta) {
      query += ` AND h.fecha <= $${i++}`;
      params.push(fechaHasta + ' 23:59:59');
    }
    if (personaFiltro) {
      query += ` AND h.persona ILIKE $${i++}`;
      params.push(`%${personaFiltro}%`);
    }

    query += ` ORDER BY h.fecha DESC`;

    const result = await pool.query(query, params);
    const historial = result.rows;

    const doc = new PDFDocument({ margin: 30, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=historial.pdf");
    doc.pipe(res);

    // Título
    doc.fontSize(16).text("Reporte de Historial de Préstamos y Devoluciones", { align: "center" });
    doc.moveDown();

    // Encabezados de tabla
    const headers = ["ID", "Componente", "Movimiento", "Cantidad", "Persona", "Observaciones", "Fecha"];
    const colWidths = [30, 120, 80, 50, 80, 120, 100];
    let x = doc.page.margins.left;
    let y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8);

    headers.forEach((h, idx) => {
      doc.text(h, x, y, { width: colWidths[idx], align: "left" });
      x += colWidths[idx];
    });
    doc.moveDown(0.5);

    // Filas
    doc.font("Helvetica").fontSize(8);
    historial.forEach(row => {
      x = doc.page.margins.left;
      y = doc.y;

      const values = [
        row.id,
        row.componente,
        row.movimiento,
        row.cantidad,
        row.persona,
        row.observaciones || "",
        new Date(row.fecha).toLocaleString()
      ];

      values.forEach((v, idx) => {
        doc.text(v.toString(), x, y, { width: colWidths[idx], align: "left" });
        x += colWidths[idx];
      });

      doc.moveDown(0.5);
    });

    doc.end();

  } catch (err) {
    console.error("Error generando PDF de historial:", err);
    res.status(500).send("Error generando PDF de historial");
  }
});

// Historial filtrado
// RUTA: Historial filtrado con filtro por persona
app.get('/reportes/historial', async (req, res) => {
  try {
    const { fechaDesde, fechaHasta, persona } = req.query;

    // Query base para historial
    let query = `
      SELECT h.id, c.nombre AS componente, h.movimiento, h.cantidad, h.persona, h.observaciones, h.fecha
      FROM historial h
      JOIN componentes c ON h.componente_id = c.id
      WHERE 1=1
    `;
    const params = [];
    let i = 1;

    // Filtro por fecha desde
    if (fechaDesde) {
      query += ` AND h.fecha >= $${i++}`;
      params.push(new Date(fechaDesde + 'T00:00:00'));
    }

    // Filtro por fecha hasta
    if (fechaHasta) {
      query += ` AND h.fecha <= $${i++}`;
      params.push(new Date(fechaHasta + 'T23:59:59'));
    }

    // Filtro por persona
    if (persona) {
      query += ` AND h.persona ILIKE $${i++}`;
      params.push(`%${persona}%`);
    }

    query += ` ORDER BY h.fecha DESC`;

    // Ejecutar consulta
    const result = await pool.query(query, params);
    const historial = result.rows;

    // Traer categorías y ubicaciones para filtros de inventario
    const catRes = await pool.query(`SELECT * FROM categorias ORDER BY nombre ASC`);
    const ubiRes = await pool.query(`SELECT * FROM ubicaciones ORDER BY nombre ASC`);

    // Traer todos los usuarios para el datalist (nombre + rol)
    const usuariosRes = await pool.query(`SELECT nombre, rol FROM usuarios ORDER BY nombre ASC`);
    const usuarios = usuariosRes.rows;

    // Renderizar vista
    res.render('reportes', {
      componentes: [], // no filtramos inventario aquí
      historial,
      categorias: catRes.rows,
      ubicaciones: ubiRes.rows,
      usuarios, // <-- importante para datalist
      filtroCategoria: null,
      filtroUbicacion: null,
      fechaDesde: fechaDesde || '',
      fechaHasta: fechaHasta || '',
      personaFiltro: persona || ''
    });

  } catch (err) {
    console.error("Error cargando historial filtrado:", err);
    res.status(500).send("Error cargando historial");
  }
});




// =================== INICIO SERVIDOR ===================
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});
