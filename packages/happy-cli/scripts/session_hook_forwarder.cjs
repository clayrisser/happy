#!/usr/bin/env node
/**
 * Session Hook Forwarder
 *
 * This script is executed by Claude's SessionStart hook, and by PreCompact
 * (DROVE-257). It reads JSON data from stdin and forwards it to Happy's hook
 * server.
 *
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [path]
 *
 * The path is optional and defaults to the SessionStart endpoint, so every
 * existing registration keeps working unchanged. It is passed rather than
 * derived from `hook_event_name` because the routing then lives in the file
 * that WRITES the registration, next to the event it registers, instead of in
 * a lookup table here that has to be kept in step with it.
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
// Anything not starting with a slash is not a path we will post to.
const path = typeof process.argv[3] === 'string' && process.argv[3].startsWith('/')
    ? process.argv[3]
    : '/hook/session-start';

if (!port || isNaN(port)) {
    process.exit(1);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);
    
    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: path,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length
        }
    }, (res) => {
        res.resume(); // Drain response
    });
    
    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });
    
    req.end(body);
});

process.stdin.resume();

