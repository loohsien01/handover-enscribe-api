/**
 * Note Template Section Orders Controller. Filename: noteTemplateSectionOrdersController.js 
 * Handles all section ordering operations for templates
 * Maintains atomic operations for reordering and batch updates
 */
import { getSupabaseClient } from '../../utils/supabase.js';

const noteTemplateSectionOrdersTable = 'noteTemplateSectionOrders';
const noteTemplatesTable = 'noteTemplates';

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
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;

    // Get all orders for templates the user has access to (RLS policies handle authorization)
    const { data, error } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .select(`
        *,
        noteTemplate:noteTemplate_id (
          id,
          user_id
        )
      `)
      .order('noteTemplate_id', { ascending: true })
      .order('order', { ascending: true });

    if (error) {
      console.error('[getAllNoteTemplateSectionOrders] Database error:', error);
      return reply.status(500).send({ error: 'Failed to fetch section orders' });
    }

    if (!data || data.length === 0) {
      return reply.status(200).send([]);
    }

    return reply.status(200).send(data);
  } catch (err) {
    console.error('[getAllNoteTemplateSectionOrders] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Gets a single note template section order by ID
 * GET /api/note-template-section-orders/:id
 */
export async function getNoteTemplateSectionOrder(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { id } = request.params;

    if (!isValidBigInt(id)) {
      return reply.status(400).send({ error: 'Invalid order ID format' });
    }

    const { data, error } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .select(`
        *,
        noteTemplate:noteTemplate_id (
          id,
          user_id
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      console.error('[getNoteTemplateSectionOrder] Database error:', error);
      return reply.status(404).send({ error: 'Order not found' });
    }

    if (!data) {
      return reply.status(404).send({ error: 'Order not found' });
    }

    return reply.status(200).send(data);
  } catch (err) {
    console.error('[getNoteTemplateSectionOrder] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Creates a new note template section order (single record)
 * POST /api/note-template-section-orders
 * Order must be the next consecutive value
 */
export async function createNoteTemplateSectionOrder(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { noteTemplate_id, section_id, order } = request.body;

    // Verify template exists (RLS enforces user authorization)
    const { data: template, error: templateError } = await supabase
      .from(noteTemplatesTable)
      .select('id')
      .eq('id', noteTemplate_id)
      .single();

    if (templateError || !template) {
      console.error('[createNoteTemplateSectionOrder] Template not found:', templateError);
      return reply.status(404).send({ error: 'Template not found' });
    }

    // Get max order for this template to validate consecutive
    const { data: maxOrderData, error: maxOrderError } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .select('order')
      .eq('noteTemplate_id', noteTemplate_id)
      .order('order', { ascending: false })
      .limit(1);

    if (maxOrderError) {
      console.error('[createNoteTemplateSectionOrder] Error fetching max order:', maxOrderError);
      return reply.status(500).send({ error: 'Failed to validate order' });
    }

    const maxOrder = maxOrderData && maxOrderData.length > 0 ? maxOrderData[0].order : 0;
    const expectedOrder = maxOrder + 1;

    if (order !== expectedOrder) {
      return reply.status(400).send({
        error: `Order must be consecutive. Expected ${expectedOrder}, got ${order}`,
        expected: expectedOrder,
        received: order,
      });
    }

    // Create the order record
    const { data: insertData, error: insertError } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .insert([
        {
          noteTemplate_id,
          noteTemplateSection_id: section_id,
          order,
          user_id: request.user.id,
        },
      ])
      .select()
      .single();

    if (insertError) {
      console.error('[createNoteTemplateSectionOrder] Insert error:', insertError);

      // Check for foreign key constraint (section doesn't exist)
      if (insertError.code === '23503') {
        return reply.status(400).send({
          error: 'Section not found',
          field: 'section_id',
        });
      }

      // Check for unique constraint (duplicate section in template)
      if (insertError.code === '23505') {
        return reply.status(409).send({
          error: 'Section already exists in this template',
          field: 'section_id',
        });
      }

      return reply.status(400).send({ error: 'Failed to create order' });
    }

    return reply.status(201).send(insertData);
  } catch (err) {
    console.error('[createNoteTemplateSectionOrder] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
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
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { noteTemplate_id, sections } = request.body;

    // Verify template exists (RLS enforces user authorization)
    const { data: template, error: templateError } = await supabase
      .from(noteTemplatesTable)
      .select('id')
      .eq('id', noteTemplate_id)
      .single();

    if (templateError || !template) {
      console.error('[updateNoteTemplateSectionOrders] Template not found:', templateError);
      return reply.status(404).send({ error: 'Template not found' });
    }

    console.log('[updateNoteTemplateSectionOrders] Reordering template:', {
      noteTemplate_id,
      count: sections.length,
    });

    // Delete all existing orders for this template
    const { error: deleteError } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .delete()
      .eq('noteTemplate_id', noteTemplate_id);

    if (deleteError) {
      console.error('[updateNoteTemplateSectionOrders] Delete error:', deleteError);
      return reply.status(500).send({ error: 'Failed to delete existing orders' });
    }

    // Insert all new orders
    const ordersToInsert = sections.map((section) => ({
      noteTemplate_id,
      noteTemplateSection_id: section.id,
      order: section.order,
      user_id: request.user.id,
    }));

    const { data: insertData, error: insertError } = await supabase
      .from(noteTemplateSectionOrdersTable)
      .insert(ordersToInsert)
      .select()
      .order('order', { ascending: true });

    if (insertError) {
      console.error('[updateNoteTemplateSectionOrders] Insert error:', insertError);

      // Check for foreign key constraint (section doesn't exist)
      if (insertError.code === '23503') {
        return reply.status(400).send({
          error: 'One or more sections not found. Reordering was not applied (atomic failure).',
          field: 'sections',
        });
      }

      // Check for unique constraint
      if (insertError.code === '23505') {
        return reply.status(400).send({
          error: 'Duplicate section IDs in request. Reordering was not applied (atomic failure).',
          field: 'sections',
        });
      }

      return reply.status(400).send({
        error: 'Failed to apply reordering. Reordering was not applied (atomic failure).',
      });
    }

    return reply.status(200).send({
      noteTemplate_id,
      sections: insertData,
    });
  } catch (err) {
    console.error('[updateNoteTemplateSectionOrders] Error:', err);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
