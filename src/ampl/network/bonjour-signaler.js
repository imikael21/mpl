let bonjour = require('bonjour')()
let WebSocket = require('ws');
let bodyParser = require('body-parser')
let request = require('request')
let uuidv4 = require('uuid/v4');

import EventEmitter from 'events'

export default class BonjourSignaller extends EventEmitter {
  constructor(peergroup, name, session) {
    super()

    if (!session) { console.log("NO SESSION PASSED TO BONJOUR SIGNALLER, MAKING ONE UP") }
    this.SESSION = session || uuidv4()
    
    if (!name) { console.log("NO NAME PASSED TO BONJOUR SIGNALLER, MAKING ONE UP") }
    this.NAME = name || "unknown"

    this.PORT = process.env.PORT || 3000 + Math.floor(Math.random() * 1000);

    this.peergroup = peergroup;
  }

  start() { 
    this.enableNetworking()
    this.emit('connect')
  }
  
  stop() { 
    this.sendGoodbye() 
    this.emit('disconnect') 
  }

  prepareSignalServer() {
    console.log("prepareSignalServer: listening on ", this.PORT)
    this.wss = new WebSocket.Server({ port: this.PORT });

    this.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        console.log('received: %s', raw);
        var signal = JSON.parse(raw)
        if (signal.action == 'hello') {
          this.greet(ws, signal)
        }
        else if (signal.action == 'offer') {
          this.hearOffer(ws, signal);
        }
      });
    });
  }

  // if a client attached and just say "hello", we tell them our session and name.
  // this allows clients that might already know us to disconnect without icing.
  greet(ws, signal) {
    ws.send(JSON.stringify({action: 'greet', session: this.SESSION, name: this.NAME}))
  }

  // in addition to manually introducing ourselves, we can also check published bonjour 
  // postings for services that match what we're looking for.
  searchBonjour() {
    this.browser = bonjour.find({ type: 'ampl' }, 
      (service) => {
        console.log("peerDiscovery(): ", service.host, ":", service.port)
        console.log("peerDiscovery(): ", service.txt)
        let meta = service.txt
        if (meta.session == this.SESSION) {
          console.log("peerDiscovery(): Own session.")
          return
        }
        this.hearHello(service.txt.name, service.txt.session, service.host, service.port)
    })
  }

  publishBonjour() {
    // text is encoded into a k/v object by bonjour
    // bonjour downcases keynames.
    let text = {session: this.SESSION, name: this.NAME}
    let publish = { name: 'ampl-'+ this.SESSION, type: 'ampl', port: this.PORT, txt: text };
    console.log("publishBonjour():",  'ampl-'+ this.SESSION, "type:", 'ampl', "port:", this.PORT, "txt:", JSON.stringify(text).split('\n').join(' '))
    this.service = bonjour.publish(publish)
  }

  manualHello(host, port) {
    console.log("sendOffer():", host+":"+port )
    let msg = {name: this.NAME, session: this.SESSION, action: 'hello'}
    
    // This is creating a pile of websockets but to do this right I need to 
    // queue up messages that arrive here until we have an 'open' websocket and then send them.
    let ws = new WebSocket("ws://"+host+":"+port+"/");
    ws.on('open', () => {
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data) => {
      console.log(data)
      let greeting = JSON.parse(data)
      this.hearHello(greeting.name, greeting.session, host, port)
    });
  }

  // initiated by .start()
  enableNetworking() {
    console.log("enableNetworking()")
    this.prepareSignalServer();

    if (!process.env.BLOCKBONJOUR) { 
      this.searchBonjour();
      setTimeout( () => { this.publishBonjour(); }, 2000) // wait a couple seconds to reduce race conditions
    }
  }

  disableNetworking() {
    console.log("enableNetworking()")
    if(this.wss) {
      // NB for future debuggers: the server will stay running until all cxns close too
      this.wss.close(); 
    }
    if(this.browser) this.browser.stop();
    if(this.service) this.service.stop();
  }

  // initiated by bonjour `find()` and `manualHello()`.
  hearHello(name, session, host, port) {
    console.log("hearHello()")
    let meta = {name: name, session: session, action: 'hello'}
    
    this.peergroup.processSignal(meta, undefined, (offer) => this.sendOffer(host, port, offer))
  }

  // initiated by hearHello()
  sendOffer(host, port, offer) {
    console.log("sendOffer():", host+":"+port )
    let msg = {name: this.NAME, session: this.SESSION, action: 'offer'}
    msg.body = offer;

    // This is creating a pile of websockets but to do this right I need to 
    // queue up messages that arrive here until we have an 'open' websocket and then send them.
    let ws = new WebSocket("ws://"+host+":"+port+"/");
    ws.on('open', () => {
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data) => {
      this.hearReply(JSON.parse(data))
    });
  }

  // express calls this in response to a post on "/"
  hearOffer(ws, signal) {
    console.log("hearOffer: from", signal.name, "/", signal.session)
    let meta = {name: signal.name, session: signal.session, action: 'offer'}
    this.peergroup.processSignal(meta, signal.body, (reply) => {
      let msg = {name: this.NAME, session: this.SESSION, body: reply, action: 'reply'}
      this.sendReply(ws, msg)
    })
  }

  // this gets sent over the wire by express.
  sendReply(ws, reply) {
    console.log("sendReply()")
    ws.send(JSON.stringify(reply))
  }

  // request receives this in response to the above.
  hearReply(reply) {
    console.log("hearReply(): from", reply.name, "/", reply.session)
    this.peergroup.processSignal(reply, reply.body, null)
  }
}
