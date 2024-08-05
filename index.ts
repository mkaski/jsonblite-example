import Fastify from 'fastify';
import JSONBLite from 'jsonblite';
import { v4 as uuidv4 } from 'uuid';

const fastify = Fastify({ logger: true });
const db = new JSONBLite('./db.jsonblite');

const GITHUB_URL = 'https://github.com/mkaski/jsonblite';

fastify.get('/', async (request, reply) => {
    const keys = db.keys();
    let html = `
      <html>
        <head>
          <style>
            body { margin: 0; padding: 0; font-family: Arial, sans-serif; display: flex; flex-direction: column; height: 100vh; text-align: center; background}
            main { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 10px; }
            article { display: block; padding: 10px 10px 5px; border: 1px solid #d0d0d0; }
            button { padding: 10px; margin: 10px auto; }
            a.key { text-decoration: none; color: #333; font-size: 11px; font-family: monospace; padding: 5px; display: block; border: 1px solid #d0d0d0; word-break: break-all; }
          </style>
        </head>
        <body>
          <h1><a href="${GITHUB_URL}">jsonblite</a></h1>
          <button onclick="location.href='/new'">Write to DB</button>
          <button onclick="location.href='/dump'">Dump JSON</button>
          <main>`;

    keys.forEach((key: string) => {
      html += `
        <article>
          <a class="key" href="/${key}">${key}</a>
          <button onclick="location.href='/delete/${key}'">Delete</button>
        </article>`;
    });

    reply.type('text/html').send(html);
});

fastify.get('/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    const value = db.read(key);

    if (value) {
        reply.send(value);
    } else {
        reply.status(404).send({ error: 'Key not found' });
    }
});

fastify.get('/new', async (request, reply) => {
    const key = uuidv4();
    const value = { value: Math.random().toString(36).substring(7) };
    db.write(key, value);

    reply.redirect('/');
});

fastify.get('/delete/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    db.delete(key);

    reply.redirect('/');
});

fastify.get('/dump', async (request, reply) => {
    db.dump();
    reply.send();
});

const start = async () => {
    try {
        await fastify.listen({ port: 3000 });
        fastify.log.info(`Server listening on http://localhost:3000`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
