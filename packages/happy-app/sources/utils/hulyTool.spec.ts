import { describe, expect, it } from 'vitest';

import { hulyOp, hulyToolTitle, isHulyTool, summarizeHulyTool } from './hulyTool';

// Result text as the huly MCP returns it: one text block holding JSON.
const block = (value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

describe('summarizeHulyTool', () => {
    it('names the ticket, its title and the fields an update wrote', () => {
        const summary = summarizeHulyTool(
            'mcp__huly__huly_update',
            { identifier: 'SHC-648', status: 'inreview' },
            block({ updated: ['status'], identifier: 'SHC-648', title: 'CI runner disk is full', status: 'inreview', priority: 'urgent', url: 'https://projects.corp.bitspur.com/tracker/SHC-648' }),
        );
        expect(summary).toMatchObject({
            op: 'update',
            identifier: 'SHC-648',
            title: 'CI runner disk is full',
            status: 'inreview',
            priority: 'urgent',
            url: 'https://projects.corp.bitspur.com/tracker/SHC-648',
            changes: [{ key: 'status', value: 'inreview' }],
        });
        expect(summary.text).toBeUndefined();
    });

    it('carries a comment as the body, not as a change row', () => {
        const summary = summarizeHulyTool(
            'mcp__huly__huly_comment',
            { identifier: 'BASED-110', text: '[agent-session] verification against the real directory' },
            block({ commented: true, identifier: 'BASED-110', title: 'drover sessions reports bus unreachable', status: 'inreview' }),
        );
        expect(summary.text).toBe('[agent-session] verification against the real directory');
        expect(summary.changes).toEqual([]);
        expect(summary.title).toBe('drover sessions reports bus unreachable');
    });

    it('shows the ticket before the result lands, from the input alone', () => {
        const summary = summarizeHulyTool('mcp__huly__huly_show', { identifier: 'DROVE-51' }, undefined);
        expect(summary.identifier).toBe('DROVE-51');
        expect(summary.title).toBeUndefined();
        expect(summary.changes).toEqual([]);
    });

    it('shows the description of a ticket it read', () => {
        const summary = summarizeHulyTool(
            'mcp__huly__huly_show',
            { identifier: 'DROVE-51' },
            block({ identifier: 'DROVE-51', title: 'Cards', status: 'inprogress', description: 'Clay, screenshot attached' }),
        );
        expect(summary.text).toBe('Clay, screenshot attached');
    });

    it('lists what a search came back with', () => {
        const summary = summarizeHulyTool(
            'mcp__huly__huly_search',
            { query: 'chromify', project: 'SHC', limit: 15 },
            block({ project: 'SHC', open: 344, matches: [
                { identifier: 'SHC-515', title: 'Wazuh iOS app on chromify', status: 'inreview', score: 0.33 },
                { identifier: 'SHC-612', title: 'Chromify recipe', status: 'backlog' },
            ] }),
        );
        expect(summary.items).toEqual([
            { identifier: 'SHC-515', title: 'Wazuh iOS app on chromify', status: 'inreview' },
            { identifier: 'SHC-612', title: 'Chromify recipe', status: 'backlog' },
        ]);
        expect(summary.changes).toEqual([{ key: 'query', value: 'chromify' }, { key: 'limit', value: 15 }]);
    });

    it('takes a created ticket title from the input until the result names it', () => {
        const summary = summarizeHulyTool('mcp__huly__huly_create', { project: 'DROVE', title: 'New thing', description: 'Body' }, undefined);
        expect(summary.title).toBe('New thing');
        expect(summary.text).toBe('Body');
        expect(summary.changes).toEqual([]);
    });
});

describe('hulyOp / hulyToolTitle / isHulyTool', () => {
    it('reads the op off the MCP tool name', () => {
        expect(hulyOp('mcp__huly__huly_update')).toBe('update');
        expect(hulyOp('mcp__huly__whoami')).toBe('whoami');
        expect(isHulyTool('mcp__huly__huly_show')).toBe(true);
        expect(isHulyTool('mcp__gitlab__gitlab_mr_get')).toBe(false);
    });

    it('titles the card with the op and the ticket', () => {
        expect(hulyToolTitle('mcp__huly__huly_update', { identifier: 'DROVE-51' })).toBe('Huly · update DROVE-51');
        expect(hulyToolTitle('mcp__huly__huly_list', { project: 'MPO' })).toBe('Huly · list MPO');
        expect(hulyToolTitle('mcp__huly__huly_whoami', {})).toBe('Huly · whoami');
    });
});
