/**
 * Patient Encounters Routes
 * Registers all patient encounter endpoints with Fastify
 */
import {
  getAllPatientEncounters,
  getPatientEncounter,
  createPatientEncounter,
  updatePatientEncounter,
  deletePatientEncounter,
  getCompletePatientEncounter,
  completePatientEncounter,
} from '../controllers/patientEncountersController.js';
import {
  patientEncounterCreateRequestSchema,
  patientEncounterUpdateRequestSchema,
  patientEncounterCompleteCreateRequestSchema,
  patientEncountersListQuerySchema,
  patientEncounterGetQuerySchema,
} from '../schemas/requests.js';

/**
 * Register patient encounters routes
 * @param {FastifyInstance} fastify - Fastify instance
 */
export async function registerPatientEncountersRoutes(fastify) {
  // GET /patient-encounters (prefix /api added by server.js)
  // Get all patient encounters for authenticated user
  fastify.get('/patient-encounters', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const parseResult = patientEncountersListQuerySchema.safeParse(request.query);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }
        request.query = parseResult.data;
        return getAllPatientEncounters(request, reply);
      } catch (error) {
        console.error('Error in GET /patient-encounters route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // POST /patient-encounters
  // Create a new patient encounter
  fastify.post('/patient-encounters', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = patientEncounterCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return createPatientEncounter(request, reply);
      } catch (error) {
        console.error('Error in POST /patient-encounters route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // GET /patient-encounters/:id
  // Get a specific patient encounter
  fastify.get('/patient-encounters/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const parseResult = patientEncounterGetQuerySchema.safeParse(request.query);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }
        request.query = parseResult.data;
        return getPatientEncounter(request, reply);
      } catch (error) {
        console.error('Error in GET /patient-encounters/:id route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // PATCH /patient-encounters/:id
  // Update a patient encounter
  fastify.patch('/patient-encounters/:id', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body
        const parseResult = patientEncounterUpdateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated body on request for controller
        request.body = parseResult.data;

        return updatePatientEncounter(request, reply);
      } catch (error) {
        console.error('Error in PATCH /patient-encounters/:id route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

  // DELETE /patient-encounters/:id
  // Delete a patient encounter
  fastify.delete('/patient-encounters/:id', {
    preHandler: [fastify.authenticate],
    handler: deletePatientEncounter,
  });

  // GET /patient-encounters/complete/:id
  // Get a complete patient encounter bundle with all linked data (recording, notes)
  fastify.get('/patient-encounters/complete/:id', {
    preHandler: [fastify.authenticate],
    handler: getCompletePatientEncounter,
  });

  // POST /patient-encounters/complete
  // Create a complete patient encounter bundle with recording and notes
  fastify.post('/patient-encounters/complete', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        // Validate request body schema
        const parseResult = patientEncounterCompleteCreateRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
          return reply.status(400).send({ error: parseResult.error });
        }

        // Set validated request body on request for controller
        request.body = parseResult.data;

        return completePatientEncounter(request, reply);
      } catch (error) {
        console.error('Error in POST /patient-encounters/complete route:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  });

}

export default registerPatientEncountersRoutes;
