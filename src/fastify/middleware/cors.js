/**
 * CORS Middleware for Fastify
 * Handles Cross-Origin Resource Sharing with allowed origin list
 */

// Production-ready allowed origins
const ALLOWED_ORIGINS = [
  // Production origins
  'https://d2okt95q961mml.cloudfront.net',
  'https://enscribe-web-prod-static.s3.amazonaws.com',
  'https://enscribe.sjpedgi.doctor',
  'https://enscribe-web.vercel.app',
  'https://emscribe.vercel.app',
  'https://enscribe.online',
  'https://app.enscribe.online',
  'https://www.app.enscribe.online',

  // Development origins
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
];

/**
 * Configure CORS for Fastify instance
 * @param {FastifyInstance} fastify - Fastify application instance
 */
export async function configureCORS(fastify) {
  // Register @fastify/cors plugin with custom configuration
  await fastify.register(import('@fastify/cors'), {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl requests)
      if (!origin) return callback(null, true);

      // Check if origin is in allowed list
      if (ALLOWED_ORIGINS.includes(origin)) {
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
}

/**
 * Manual CORS header middleware (fallback if plugin not used)
 * @param {FastifyRequest} request - Fastify request
 * @param {FastifyReply} reply - Fastify reply
 */
export async function corsHeadersMiddleware(request, reply) {
  const origin = request.headers.origin;

  // Set CORS headers if origin is allowed
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
  }

  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Access-Control-Max-Age', '86400');

  // Handle preflight requests
  if (request.method === 'OPTIONS') {
    return reply.send();
  }
}

export const ALLOWED_ORIGINS_LIST = ALLOWED_ORIGINS;
