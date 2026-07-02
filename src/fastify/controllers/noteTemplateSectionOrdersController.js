/**
 * Note Template Section Orders Controller. Filename: noteTemplateSectionOrdersController.js
 * Handles all section ordering operations for templates
 * Maintains atomic operations for reordering and batch updates
 */
import {
  pgQueryOne,
  pgQueryRows,
  pgErrorMessage,
  isPgUniqueViolation,
  pgCoerceBigIntFields,
  pgCoerceBigIntFieldsRows,
} from '../../utils/pgQueryHelpers.js';
import { getSupabasePostgresPool } from '../../utils/supabasePostgresPool.js';

const ORDER_BIGINT_FIELDS = ['id', 'noteTemplate_id', 'noteTemplateSection_id'];

function normalizeOrderRow(row) {
  if (!row) return row;
  const normalized = pgCoerceBigIntFields(row, ORDER_BIGINT_FIELDS);
  if (normalized.noteTemplate && typeof normalized.noteTemplate === 'object') {
    normalized.noteTemplate = pgCoerceBigIntFields(normalized.noteTemplate, ['id']);
  }
  return normalized;
}

function normalizeOrderRows(rows) {
  return rows.map(normalizeOrderRow);
}

const noteTemplateSectionOrdersTable = '"noteTemplateSectionOrders"';
const noteTemplatesTable = '"noteTemplates"';

const SECTION_ORDERS_WITH_TEMPLATE = `
  SELECT o.*,
         json_build_object('id', t.id, 'user_id', t.user_id) AS "noteTemplate"
    FROM ${noteTemplateSectionOrdersTable} o
    JOIN ${noteTemplatesTable} t ON t.id = o."noteTemplate_id"
`;

/**
 * Helper: Validates bigint ID format
 */
function isValidBigInt(id) {
  if (!id) return false;
  try {
    const parsed = BigInt(id);
    return parsed > 0n;
  } catch (error) {
    return false;
  }
}

/**
 * Gets all note template section orders for authenticated user
 * Returns section orders for all templates user has access to (self + system)
 * GET /api/note-template-section-orders
 */
export async function getAllNoteTemplateSectionOrders(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const data = await pgQueryRows(
      `${SECTION_ORDERS_WITH_TEMPLATE}
       WHERE o.user_id = $1 OR o.user_id IS NULL
       ORDER BY o."noteTemplate_id" ASC, o."order" ASC`,
      [user.id]
    );

    return reply.status(200).send(normalizeOrderRows(data));
  } catch (err) {
    console.error('[getAllNoteTemplateSectionOrders] Error:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Gets a single note template section order by ID
 * GET /api/note-template-section-orders/:id
 */
export async function getNoteTemplateSectionOrder(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid order ID format' });
    }

    const data = await pgQueryOne(
      `${SECTION_ORDERS_WITH_TEMPLATE}
       WHERE o.id = $1
         AND (o.user_id = $2 OR o.user_id IS NULL)`,
      [id, user.id]
    );

    if (!data) {
      return reply.status(404).send({ error: 'Order not found' });
    }

    return reply.status(200).send(normalizeOrderRow(data));
  } catch (err) {
    console.error('[getNoteTemplateSectionOrder] Error:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Creates a new note template section order (single record)
 * POST /api/note-template-section-orders
 * Order must be the next consecutive value
 */
export async function createNoteTemplateSectionOrder(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { noteTemplate_id, section_id, order } = request.body;

    const template = await pgQueryOne(
      `SELECT id
         FROM ${noteTemplatesTable}
        WHERE id = $1
          AND (user_id = $2 OR user_id IS NULL)`,
      [noteTemplate_id, user.id]
    );

    if (!template) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    const maxOrderRow = await pgQueryOne(
      `SELECT "order"
         FROM ${noteTemplateSectionOrdersTable}
        WHERE "noteTemplate_id" = $1
        ORDER BY "order" DESC
        LIMIT 1`,
      [noteTemplate_id]
    );

    const maxOrder = maxOrderRow ? maxOrderRow.order : 0;
    const expectedOrder = maxOrder + 1;

    if (order !== expectedOrder) {
      return reply.status(400).send({
        error: `Order must be consecutive. Expected ${expectedOrder}, got ${order}`,
        expected: expectedOrder,
        received: order,
      });
    }

    try {
      const insertData = await pgQueryOne(
        `INSERT INTO ${noteTemplateSectionOrdersTable} (
           "noteTemplate_id", "noteTemplateSection_id", "order", user_id
         ) VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [noteTemplate_id, section_id, order, user.id]
      );

      return reply.status(201).send(normalizeOrderRow(insertData));
    } catch (insertError) {
      console.error('[createNoteTemplateSectionOrder] Insert error:', insertError);

      if (insertError && typeof insertError === 'object' && 'code' in insertError && insertError.code === '23503') {
        return reply.status(400).send({
          error: 'Section not found',
          field: 'section_id',
        });
      }

      if (isPgUniqueViolation(insertError)) {
        return reply.status(409).send({
          error: 'Section already exists in this template',
          field: 'section_id',
        });
      }

      return reply.status(400).send({ error: 'Failed to create order' });
    }
  } catch (err) {
    console.error('[createNoteTemplateSectionOrder] Error:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}

/**
 * Updates template section orders (atomic batch reorder)
 * PATCH /api/note-template-section-orders
 * Replaces ALL section orders for a template with provided list
 * Entire operation is atomic: succeeds completely or not at all
 */
export async function updateNoteTemplateSectionOrders(request, reply) {
  try {
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { noteTemplate_id, sections } = request.body;

    const template = await pgQueryOne(
      `SELECT id
         FROM ${noteTemplatesTable}
        WHERE id = $1
          AND (user_id = $2 OR user_id IS NULL)`,
      [noteTemplate_id, user.id]
    );

    if (!template) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    console.log('[updateNoteTemplateSectionOrders] Reordering template:', {
      noteTemplate_id,
      count: sections.length,
    });

    const pool = getSupabasePostgresPool();
    const client = await pool.connect();

    try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM ${noteTemplateSectionOrdersTable}
        WHERE "noteTemplate_id" = $1`,
      [noteTemplate_id]
    );

    for (const section of sections) {
      await client.query(
        `INSERT INTO ${noteTemplateSectionOrdersTable} (
           "noteTemplate_id", "noteTemplateSection_id", "order", user_id
         ) VALUES ($1, $2, $3, $4)`,
        [noteTemplate_id, section.id, section.order, user.id]
      );
    }

    const { rows: insertData } = await client.query(
      `SELECT *
         FROM ${noteTemplateSectionOrdersTable}
        WHERE "noteTemplate_id" = $1
        ORDER BY "order" ASC`,
      [noteTemplate_id]
    );

    await client.query('COMMIT');

    return reply.status(200).send({
      noteTemplate_id: pgCoerceBigIntFields({ noteTemplate_id }, ['noteTemplate_id']).noteTemplate_id,
      sections: normalizeOrderRows(insertData),
    });
    } catch (err) {
      await client.query('ROLLBACK');

      console.error('[updateNoteTemplateSectionOrders] Error:', err);

      if (err && typeof err === 'object' && 'code' in err && err.code === '23503') {
        return reply.status(400).send({
          error: 'One or more sections not found. Reordering was not applied (atomic failure).',
          field: 'sections',
        });
      }

      if (isPgUniqueViolation(err)) {
        return reply.status(400).send({
          error: 'Duplicate section IDs in request. Reordering was not applied (atomic failure).',
          field: 'sections',
        });
      }

      return reply.status(400).send({
        error: 'Failed to apply reordering. Reordering was not applied (atomic failure).',
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[updateNoteTemplateSectionOrders] Error:', err);
    return reply.status(500).send({ error: pgErrorMessage(err) });
  }
}
