// Importación de módulos necesarios
import express from 'express' // Framework para crear el servidor web
import { createServer } from 'node:http' // Módulo nativo para crear un servidor HTTP
import { fileURLToPath } from 'node:url' // Módulo para manejar URLs y rutas de archivos
import { dirname, join } from 'node:path' // Módulo para manejar rutas de archivos
import { Server } from 'socket.io' // Biblioteca para comunicación en tiempo real
import sqlite3 from 'sqlite3' // Módulo para interactuar con SQLite
import { open } from 'sqlite' // Función para abrir la base de datos SQLite
import { availableParallelism } from 'node:os' // Para determinar el número de núcleos de CPU disponibles
import cluster from 'node:cluster' // Módulo para crear procesos hijos en un clúster
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter' // Adaptador para manejar Socket.IO en un entorno de clúster

const PORT = 3000 // Puerto en el que se ejecutará el servidor

// Abrir la base de datos SQLite y crear la tabla de mensajes si no existe
const db = await open({
  filename: 'chat.db', // Nombre del archivo de base de datos
  driver: sqlite3.Database // Driver SQLite para la conexión
})
await db.exec(` // Ejecutar una consulta SQL para crear la tabla
    CREATE TABLE IF NOT EXISTS messages ( // Crear la tabla "messages"
        id INTEGER PRIMARY KEY AUTOINCREMENT, // ID autoincremental
        client_offset TEXT UNIQUE, // Offset único para identificar mensajes del cliente
        content TEXT // Contenido del mensaje
    );
  `)

// Comprobación si el proceso actual es el proceso primario del clúster
if (cluster.isPrimary) {
  const numCPUs = availableParallelism() // Obtener el número de núcleos de CPU disponibles
  // Crear un proceso hijo por cada núcleo disponible
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      // Crear un nuevo proceso hijo
      PORT: 3000 + i // Asignar un puerto diferente a cada proceso hijo
    })
  }

  // Configurar el adaptador en el hilo primario
  setupPrimary()
} else {
  // Código que se ejecuta en los procesos hijos
  const app = express() // Crear una instancia de Express
  const server = createServer(app) // Crear un servidor HTTP a partir de la aplicación Express
  const io = new Server(server, {
    // Inicializar Socket.IO
    connectionStateRecovery: {} // Configurar la recuperación del estado de conexión
  })

  const __dirname = dirname(fileURLToPath(import.meta.url)) // Obtener el directorio actual del archivo

  // Definir la ruta principal del servidor
  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html')) // Enviar el archivo index.html como respuesta
  })

  // Manejar eventos de conexión de Socket.IO
  io.on('connection', async (socket) => {
    console.log('User connected') // Mensaje en consola cuando un usuario se conecta

    // Manejar el evento de mensaje de chat
    socket.on('chat message', async (msg, clientOffset, callback) => {
      let result // Variable para almacenar el resultado de la consulta a la base de datos
      try {
        // Intentar insertar el mensaje en la base de datos
        result = await db.run(
          'INSERT INTO messages (content, client_offset) VALUES (?, ?)', // Consulta SQL
          msg, // Mensaje a insertar
          clientOffset // Offset del cliente
        )
      } catch (e) {
        // Manejar errores durante la inserción
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          // Si el mensaje ya existe
          callback() // Notificar al cliente que el mensaje ya fue insertado
        } else {
          // Otros errores se manejan permitiendo que el cliente intente de nuevo
        }
        return // Salir de la función
      }
      // Emitir el mensaje a todos los sockets conectados
      io.emit('chat message', msg, result.lastID)
      // Reconocer el evento para el cliente
      callback()
    })

    // Comprobar si la recuperación del estado de conexión fue exitosa
    if (!socket.recovered) {
      // Si no fue exitosa, intentar recuperar mensajes anteriores
      try {
        await db.each(
          'SELECT id, content FROM messages WHERE id > ?', // Consulta SQL para obtener mensajes
          [socket.handshake.auth.serverOffset || 0], // Usar el offset proporcionado por el cliente o 0
          (_err, row) => {
            // Emitir cada mensaje recuperado al socket del cliente
            socket.emit('chat message', row.content, row.id)
          }
        )
      } catch (e) {
        // Manejar errores en la recuperación de mensajes
      }
    }
  })

  // Iniciar el servidor en el puerto especificado
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`) // Mensaje en consola indicando que el servidor está en ejecución
  })
}
