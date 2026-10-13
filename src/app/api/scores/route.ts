import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

// ============ API рекордов: GET /api/scores, POST /api/scores ============

const ScoreSchema = z.object({
  name: z.string().trim().min(1).max(24),
  score: z.number().int().min(0).max(10_000_000),
  kills: z.number().int().min(0).max(1_000_000),
  level: z.number().int().min(1).max(200),
  timeSurvived: z.number().int().min(0).max(3600),
  victory: z.boolean(),
});

export async function GET(req: NextRequest) {
  try {
    const limitRaw = req.nextUrl.searchParams.get('limit') ?? '10';
    const limit = Math.min(50, Math.max(1, Number.parseInt(limitRaw, 10) || 10));
    const rows = await db.gameResult.findMany({
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return NextResponse.json(rows);
  } catch (err) {
    console.error('GET /api/scores failed', err);
    return NextResponse.json({ error: 'failed to load scores' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = ScoreSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid payload', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const row = await db.gameResult.create({ data: parsed.data });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    console.error('POST /api/scores failed', err);
    return NextResponse.json({ error: 'failed to save score' }, { status: 500 });
  }
}
