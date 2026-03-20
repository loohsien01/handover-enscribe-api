import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env.local for development
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.local');
dotenv.config({ path: envPath });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookiePlugin from '@fastify/cookie';
import pino from 'pino';
import authenticationPlugin from './plugins/authentication.js';
import { ALLOWED_ORIGINS_LIST } from './middleware/cors.js';
import authRoutes from './routes/auth.js';
import dotPhrasesRoutes from './routes/dotPhrases.js';
import patientEncountersRoutes from './routes/patientEncounters.js';
import { registerRecordingsRoutes } from './routes/recordings.js';
import { registerTranscriptsRoutes } from './routes/transcripts.js';
import { registerSoapNotesRoutes } from './routes/soapNotes.js';
import { registerMaskPhiRoutes } from './routes/maskPhi.js';
import { registerTranscribeRoutes } from './routes/transcribe.js';
import { registerPromptLlmJobsRoutes } from './routes/promptLlmJobs.js';
import { registerNoteTemplateSectionsRoutes } from './routes/noteTemplateSections.js';
import { registerNoteTemplatesRoutes } from './routes/noteTemplates.js';
import { registerNoteTemplatesCompleteRoutes } from './routes/noteTemplatesComplete.js';
import { registerNoteTemplateSectionOrdersRoutes } from './routes/noteTemplateSectionOrders.js';

/**
 * Create and configure Fastify application
 * Handles all Fastify backend routes and middleware
 */
async function createFastifyApp(options = {}) {
  const {
    port = process.env.FASTIFY_PORT || 3001,
    host = process.env.FASTIFY_HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'),
    environment = process.env.NODE_ENV || 'development',
  } = options;

  // Configure Pino logger for CloudWatch with request filtering
  const pinoLogger = pino({
    level: environment === 'production' ? 'info' : 'debug',
    serializers: {
      // Custom serializer to filter out /health and / logs
      req: (req) => {
        const url = req.url;
        // Return null to skip logging this request entirely
        if (url === '/health' || url === '/') {
          return null;
        }
        return {
          method: req.method,
          url: req.url,
          hostname: req.hostname,
          remoteAddress: req.remoteAddress,
          remotePort: req.remotePort,
        };
      },
    },
    transport: environment === 'development' ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    } : undefined,
  });

  // Create Fastify instance with Pino logger
  const fastify = Fastify({
    logger: pinoLogger,
    disableRequestLogging: true, // Completely disable Fastify's auto request logging
  });

  // Add request/response logging for non-health endpoints
  fastify.addHook('onRequest', async (request, reply) => {
    // Only log actual API requests (not health checks)
    if (request.url !== '/' && request.url !== '/health') {
      fastify.log.info({
        event: 'request',
        method: request.method,
        url: request.url,
        ip: request.ip,
      });
    }
  });

  fastify.addHook('onResponse', async (request, reply) => {
    // Only log actual API responses (not health checks)
    if (request.url !== '/' && request.url !== '/health') {
      const responseTime = reply.elapsedTime ? Math.round(reply.elapsedTime) : 0;
      fastify.log.info({
        event: 'response',
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        responseTime: `${responseTime}ms`,
      });
    }
  });

  // Register CORS plugin with production-ready allowed origins
  await fastify.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl requests)
      if (!origin) return callback(null, true);

      // Check if origin is in allowed list
      if (ALLOWED_ORIGINS_LIST.includes(origin)) {
        return callback(null, true);
      }

      // Reject disallowed origins
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400, // 24 hours
  });

  // Register cookie parser plugin (makes fastify.parseCookie available)
  await fastify.register(cookiePlugin);

  // Register authentication plugin (makes fastify.authenticate available)
  await fastify.register(authenticationPlugin);

  // Test route to verify routing works
  fastify.get('/test-direct', async (request, reply) => {
    return reply.status(200).send({ message: 'direct test works' });
  });

  // Register route plugins
  await fastify.register(async (apiScope) => {
    await apiScope.register(authRoutes);
    await apiScope.register(dotPhrasesRoutes);
    await apiScope.register(patientEncountersRoutes);
    await registerRecordingsRoutes(apiScope);
    await registerTranscriptsRoutes(apiScope);
    await registerSoapNotesRoutes(apiScope);
    await registerNoteTemplateSectionsRoutes(apiScope);
    await registerNoteTemplatesRoutes(apiScope);
    await registerNoteTemplatesCompleteRoutes(apiScope);
    await registerNoteTemplateSectionOrdersRoutes(apiScope);
    await registerMaskPhiRoutes(apiScope);
    await registerTranscribeRoutes(apiScope);
  }, { prefix: '/api' });

  // Register job-based routes under /api/jobs
  await fastify.register(registerPromptLlmJobsRoutes, { prefix: '/api/jobs' });

  // Health check route (no auth required)
  fastify.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  // Global error handler
  fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error('Error:', error);

    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal Server Error';

    // Handle Fastify validation errors with proper error response
    if (error.code === 'FST_ERR_VALIDATION') {
      fastify.log.error('Validation Error Details:', {
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        validation: error.validation
      });
      const response = {
        error: 'Validation Error',
        message: message
      };
      if (error.validation && Array.isArray(error.validation)) {
        response.validation = error.validation;
      }
      return reply.status(statusCode).send(response);
    }

    return reply.status(statusCode).send({
      statusCode,
      error: error.name || 'Error',
      message,
    });
  });

  return { fastify, port, host };
}

/**
 * Start the Fastify server
 */
async function startServer() {
  try {
    const { fastify, port, host } = await createFastifyApp();

    await fastify.listen({ port, host });

    console.log(`\n✓ Fastify server running on http://${host}:${port}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only start server if this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export { createFastifyApp, startServer };
