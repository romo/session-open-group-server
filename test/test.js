const fs           = require('fs');
const path         = require('path');
const nconf        = require('nconf');
const assert       = require('assert');
const lokinet      = require('loki-launcher/lokinet');
const crypto       = require('crypto');
const bb           = require('bytebuffer');
const libsignal    = require('libsignal');
const adnServerAPI = require('../fetchWrapper');
const config       = require('../config');

const ADN_SCOPES = 'basic stream write_post follow messages update_profile files export';

// Look for a config file
const disk_config = config.getDiskConfig();
//console.log('disk_config', disk_config)

const config_path = path.join(__dirname, '/../config.json');
nconf.argv().env('__').file({file: config_path});
console.log('test config_path', config_path);

const webport = nconf.get('web:port') || 7070;
const webbind = nconf.get('web:listen') || '127.0.0.1';
const webclient = webbind !== '0.0.0.0' ? webbind : '127.0.0.1';
const base_url = 'http://' + webclient + ':' + webport + '/';

const overlay_bindhost = process.env.overlay__host || nconf.get('web:listen') || '127.0.0.1';
console.log('overlay_bindhost', overlay_bindhost);
const overlay_host = overlay_bindhost !== '0.0.0.0' ? overlay_bindhost : '127.0.0.1';
console.log('overlay_host    ', overlay_host);
const overlay_port = parseInt(disk_config.api && disk_config.api.port) || nconf.get('web:port') || 7070;
// has to have the trailing slash
const overlay_url = base_url;

const platform_api_url = disk_config.api && disk_config.api.api_url || base_url;

// is it set up?
const admin_modkey=nconf.get('admin:modKey');
let hasAdminAPI = !!admin_modkey;

let platform_admin_url = disk_config.api && disk_config.api.admin_url && disk_config.api.admin_url.replace(/\/$/, '');
if (!platform_admin_url) {
  // http://localhost:3000
  var admin_port=nconf.get('admin:port') || 3000;
  var admin_listen=nconf.get('admin:listen') || '127.0.0.1';
  platform_admin_url = 'http://' + admin_listen + ':' + admin_port + '/';
}
//console.log('env/config.json   ', base_url); // platform
//console.log('loki.ini          ', platform_api_url); // platform
//console.log('overlay_url       ', overlay_url); // copied from base_url...
console.log('platform_api_url  ', platform_api_url);
//console.log('platform_admin_url', platform_admin_url);

// This may require the admin interface to be configure, hrm...
// do we really need that for unit tests?
// well if we're not starting the server, cache would have to be proxied...

// configure the admin interface for use
// can be easily swapped out later
const proxyAdmin = require('../server/dataaccess.proxy-admin');
// fake dispatcher that only implements what we need
proxyAdmin.dispatcher = {
  // ignore local user updates
  updateUser: (user, ts, cb) => { cb(user); },
  // ignore local message updates
  setMessage: (message, cb) => { if (cb) cb(message); },
}
// backward compatible
if (proxyAdmin.start) {
  proxyAdmin.start(nconf);
}
proxyAdmin.apiroot = platform_api_url;
if (proxyAdmin.apiroot.replace) {
  proxyAdmin.apiroot = proxyAdmin.apiroot.replace(/\/$/, '');
}
proxyAdmin.adminroot = platform_admin_url;
if (proxyAdmin.adminroot.replace) {
  proxyAdmin.adminroot = proxyAdmin.adminroot.replace(/\/$/, '');
}

const cache = proxyAdmin

let weStartedUnifiedServer = false;
const ensureUnifiedServer = () => {
  return new Promise((resolve, rej) => {
    //const platformURL = new URL(base_url)
    //console.log('platform port', platformURL.port)
    console.log('unified port', webport);
    lokinet.portIsFree(overlay_bindhost, webport, function(free) {
      //console.log('overlay_bindhost', overlay_bindhost, 'overlay_host', overlay_host, 'free', free)
      if (free) {
        // make sure we use the same config...
        process.env['config-file-path'] = config_path
        process.env['admin:modKey'] = 'JustMakingSureThisIsEnabled';
        hasAdminAPI = true;
        const startPlatform = require('../server/app');
        weStartedUnifiedServer = true;
      } else {
        console.log('detected running overlay server, testing that');
      }
      resolve();
    });
  });
};

const modApi      = new adnServerAPI(overlay_url);
const overlayApi  = new adnServerAPI(overlay_url);
const platformApi = new adnServerAPI(platform_api_url);
// probably should never be used...
// const adminApi    = new adnServerAPI(platform_admin_url, disk_config.api && disk_config.api.modKey || '123abc');

let modPubKey = '';

// grab a mod from ini
const selectModToken = async (channelId) => {
  if (process.env.mod_token) {
    // assuming it's valid
    return process.env.mod_token;
  }
  if (disk_config.test && disk_config.test.mod_token) {
    // assuming it's valid
    return disk_config.test.mod_token;
  }
  //console.log('selectModToken for', channelId);
  const modRes = await overlayApi.serverRequest(`loki/v1/channel/${channelId}/get_moderators`);
  //console.log('modRes', modRes);
  if (!modRes.response.moderators) {
    console.warn('cant read moderators for channel', channelId, res);
    return;
  }
  if (!modRes.response.moderators.length && !weStartedUnifiedServer) {
    console.warn('no moderators for channel', channelId + ', cant addTempMod skipping moderation tests');
    return;
  }
  const modKeys = modRes.response.moderators;
  //console.log('found moderators', modKeys)
  let modToken = '';
  if (!modKeys.length) {
    // we started platform?
    if (weStartedUnifiedServer) {
      console.warn('test.js - no moderators configured and we control overlayServer, creating temporary moderator');
      const ourModKey = libsignal.curve.generateKeyPair();
      // encode server's pubKey in base64
      const ourModPubKey64 = bb.wrap(ourModKey.pubKey).toString('base64');
      const modPubKey = bb.wrap(ourModKey.pubKey).toString('hex');
      modToken = await get_challenge(ourModKey, modPubKey);
      await submit_challenge(modToken, modPubKey);
      // now elevate to a moderator
      const userid = await getUserID(modPubKey, modToken);
      // console.log('user', userid);
      if (userid) {
        await config.addTempModerator(userid);
      } else {
        console.warn('Could not look up authorized user', user);
        return;
      }
      return modToken;
    } else {
      console.warn('no moderators configured and cant addTempMod, skipping moderation tests');
      return;
    }
  }
  if (!hasAdminAPI) {
    console.log('Admin API is not enabled, so we can\'t run moderator tests without a key');
    return;
  }
  const selectedMod = Math.floor(Math.random() * modKeys.length);
  modPubKey = modKeys[selectedMod];
  console.log('selected mod @' + modPubKey);
  if (!modPubKey) {
    console.warn('selectedMod', selectedMod, 'not in', modKeys.length);
    return;
  }
  // FIXME
  function getModTokenByUsername(username) {
    return new Promise((resolve, reject) => {
      // not available without proxy-admin...
      cache.getAPITokenByUsername(username, function(data, err) {
        if (err) console.error('getModTokenByUsername err', err);
        //console.log('data', data)
        resolve(data.token);
      });
    });
  }
  const res = await getModTokenByUsername(modPubKey);
  if (res) {
    modToken = res;
  }
  /*
  const res = await adminApi.serverRequest('tokens/@'+modPubKey, {});
  if (res.response && res.response.data) {
    modToken = res.response.data.token;
  }
  */

  // it's async
  /*
  if (res.response && res.response.data === null) {
    console.log('need to create a token for this moderator')
    cache.getUserID(modPubKey, (user, err) => {
      if (err) console.error('getUserID err', err)
      if (!user || !user.id) {
        console.warn('No such moderator user object for', modPubKey);
        // create user...
        process.exit();
      }
      cache.createOrFindUserToken(user.id, 'messenger', ADN_SCOPES, (tokenObj, err) => {
        if (err) console.error('createOrFindUserToken err', err)
        console.log('tokenObj', tokenObj);
      })
    })
  }
  */
  if (!modToken) console.warn('modToken failure! res', res);
  return modToken;
}

// make our local keypair
const ourKey = libsignal.curve.generateKeyPair();
// encode server's pubKey in base64
const ourPubKey64 = bb.wrap(ourKey.pubKey).toString('base64');
const ourPubKeyHex = bb.wrap(ourKey.pubKey).toString('hex');
console.log('running as', ourPubKeyHex);

const IV_LENGTH = 16;
const DHDecrypt = async (symmetricKey, ivAndCiphertext) => {
  const iv = ivAndCiphertext.slice(0, IV_LENGTH);
  const ciphertext = ivAndCiphertext.slice(IV_LENGTH);
  return libsignal.crypto.decrypt(symmetricKey, ciphertext, iv);
}

// globally passing overlayApi
function get_challenge(ourKey, ourPubKeyHex) {
  return new Promise((resolve, rej) => {
    describe(`get challenge for ${ourPubKeyHex} /loki/v1/get_challenge`, async function() {
      // this can be broken into more it() if desired
      //it("returns status code 200", async () => {
      let tokenString
      let result
      try {
        result = await overlayApi.serverRequest('loki/v1/get_challenge', {
          params: {
           pubKey: ourPubKeyHex
          }
        });
        assert.equal(200, result.statusCode);
        const body = result.response;
        //console.log('get challenge body', body);
        // body.cipherText64
        // body.serverPubKey64 // base64 encoded pubkey

        // console.log('serverPubKey64', body.serverPubKey64);
        const serverPubKeyBuff = Buffer.from(body.serverPubKey64, 'base64')
        const serverPubKeyHex = serverPubKeyBuff.toString('hex');
        //console.log('serverPubKeyHex', serverPubKeyHex)

        const ivAndCiphertext = Buffer.from(body.cipherText64, 'base64');

        const symmetricKey = libsignal.curve.calculateAgreement(
          serverPubKeyBuff,
          ourKey.privKey
        );
        const token = await DHDecrypt(symmetricKey, ivAndCiphertext);
        tokenString = token.toString('utf8');
      } catch (e) {
        console.error('platformApi.serverRequest err', e, result)
        tokenString = '';
        return rej();
      }

      //console.log('tokenString', tokenString);
      resolve(tokenString);
      //});
    });
  });
}

const submit_challenge = (tokenString, pubKey) => {
  // we use this promise to delay resolution
  return new Promise((resolve, rej) => {
    // I don't think we need or want this describe at all...
    describe(`submit challenge for ${tokenString} /loki/v1/submit_challenge`, async function() {
      //it("returns status code 200", async () => {
        const result = await overlayApi.serverRequest('loki/v1/submit_challenge', {
          method: 'POST',
          objBody: {
            pubKey: pubKey,
            token: tokenString,
          },
          noJson: true
        });
        assert.equal(200, result.statusCode);
        // body should be ''
        //console.log('submit challenge body', body);
        resolve();
      //});
    });
  });
}

// requires overlayApi to be configured with a token
function getUserID(pubKey, token) {
  return new Promise((resolve, rej) => {
    if (token) cache.token = token;
    cache.getUserID(pubKey, function(user, err, meta) {
      //assert.equal(200, result.statusCode);
      resolve(user && user.id);
    });
  });
}

function get_deletes(channelId) {
  return new Promise((resolve, rej) => {
    describe("get deletes /loki/v1/channels/1/deletes", async function() {
      //it("returns status code 200", async () => {
        const result = await overlayApi.serverRequest('loki/v1/channels/1/deletes');
        assert.equal(200, result.statusCode);
        resolve();
      //});
    });
  });
}

function create_message(channelId) {
  return new Promise((resolve, rej) => {
    describe("create message /channels/1/messages", async function() {
      //it("returns status code 200", async () => {
        // create a dummy message
        let result;
        try {
          result = await platformApi.serverRequest('channels/1/messages', {
            method: 'POST',
            objBody: {
              text: 'testing message',
            },
          });
          //console.log('create message result', result, 'token', platformApi.token);
          if (result.statusCode === 401) {
            console.error('used token', platformApi.token);
            const linfo = await overlayApi.serverRequest('loki/v1/user_info');
            console.log('lokiInfo', linfo);
            const tinfo = await platformApi.serverRequest('token');
            console.log('tokenInfo', tinfo);
          }
          assert.equal(200, result.statusCode);
        } catch (e) {
          console.error('platformApi.serverRequest err', e, result)
          return rej();
        }
        resolve(result.response.data.id);
      //});
    });
  });
}

function get_message(messageId) {
  return new Promise(async (resolve, rej) => {
    // not really a test
    //describe(`get channel /channels/${channelId}`, function() {
      //it("returns status code 200", async () => {
        // get a channel
        const result = await platformApi.serverRequest(`channels/messages`, {
          params: {
            ids: messageId
          }
        });
        //assert.equal(200, result.statusCode);
        resolve(result.response.data);
      //});
    //});
  });
}

const runIntegrationTests = async (ourKey, ourPubKeyHex) => {
  let channelId = 1; // default channel to try to test first

  // get our token
  let tokenString, userid, mod_userid;
  describe('get our token', function() {
    it('get token', async function() {
      if (disk_config.whitelist) {
        console.log('Oh were in whitelist model, going to need to permit ourselves...', ourPubKeyHex);
        const modToken = await selectModToken(channelId);
        if (!modToken) {
          console.log('No mod token to whitelist temporary user', ourPubKeyHex);
          process.exit(1);
        }
        modApi.token = modToken;
        const result = await modApi.serverRequest('loki/v1/moderation/whitelist/@' + ourPubKeyHex, {
          method: 'POST',
        });
        console.log('Ok attempted to whitelist', ourPubKeyHex);
        if (result.statusCode !== 200 || result.response.meta.code !== 200) {
          console.log('Failed to whitelist temporary user', ourPubKeyHex, result);
          process.exit(1);
        }
      }
      tokenString = await get_challenge(ourKey, ourPubKeyHex);
      // console.log('tokenString', tokenString);
    });
    it('activate token', async function() {
      // activate token
      await submit_challenge(tokenString, ourPubKeyHex);
    });
    it('set token', async function() {
      // set token
      overlayApi.token = tokenString;
      platformApi.token = tokenString;
      //userid = await getUserID(ourPubKeyHex);
    });

    it('user info (non-mod)', async function() {
      // test token endpoints
      const result = await overlayApi.serverRequest('loki/v1/user_info');
      //console.log('user user_info result', result)
      assert.equal(200, result.statusCode);
      assert.ok(result.response);
      assert.ok(result.response.data);
      // we're a freshly created user (hopefully)
      assert.ok(!result.response.data.moderator_status);
      assert.ok(result.response.data.user_id);
      userid = result.response.data.user_id;
    });

    // test moderator security...
    describe('moderator security tests', function() {
      it('cant promote to moderator', async function() {
        const result = await overlayApi.serverRequest(`loki/v1/moderators/${userid}`, {
          method: 'POST',
        });
        assert.equal(401, result.statusCode);
      });
      it('cant blacklist', async function() {
        const result = await overlayApi.serverRequest(`loki/v1/moderation/blacklist/${userid}`, {
          method: 'POST',
        });
/*
{
  err: 'statusCode',
  statusCode: 401,
  response: {
    meta: {
      code: 401,
      error_message: 'Call requires authentication: Authentication required to fetch token.'
    }
  }
}
*/
        assert.equal(401, result.statusCode);
      });
    });

    // make sure we have a channel to test with
    describe('channel testing', function() {
      it('make sure we have a channel to test', async function() {
        const result = await platformApi.serverRequest(`channels/${channelId}`, {
          params: {
            include_recent_message: 1
          }
        });
        const chnlCheck = result.response.data;
        if (Array.isArray(chnlCheck)) {
          // make a channel for testing
          const result = await platformApi.serverRequest('channels', {
            method: 'POST',
            objBody: {
              type: 'moe.sapphire.test',
            },
          });
          assert.equal(200, result.statusCode);
          channelId = result.response.data.id;
          console.log('created channel', channelId);
        }
      });
      let messageId, messageId1, messageId2, messageId3, messageId4, messageId5
      it('create message to test with', async function() {
        // well we need to create a new message for moderation test
        messageId = await create_message(channelId);
        messageId1 = await create_message(channelId);
        messageId2 = await create_message(channelId);
        messageId3 = await create_message(channelId);
        messageId4 = await create_message(channelId);
        messageId5 = await create_message(channelId);
      });

      it('user can report message', async function() {
        const result = await overlayApi.serverRequest(`loki/v1/channels/messages/${messageId}/report`, {
          method: 'POST',
        });
        assert.equal(200, result.statusCode);
        // result.response.data will be []
      });

      it('user cant mod delete message', async function() {
        const result = await overlayApi.serverRequest(`loki/v1/moderation/message/${messageId}`, {
          method: 'DELETE',
        });
        assert.equal(401, result.statusCode);
        // result.response.data will be undefined
      });
      it('user multi delete test', async function () {
        //let message = await get_message(messageId);
        if (messageId3 && messageId4) {
          const result = await overlayApi.serverRequest('loki/v1/messages', {
            method: 'DELETE',
            params: {
              ids: [messageId3, messageId4].join(',')
            }
          });
          assert.equal(200, result.statusCode);
          assert.ok(result.response.data.every(x => x.is_deleted));
        } else {
          console.log('skipping');
        }
        //message = await get_message(messageId);
        //console.log('message after', message);
      });
      it('user single delete through multi endpoint test', async function () {
        //let message = await get_message(messageId);
        if (messageId5) {
          const result = await overlayApi.serverRequest('loki/v1/messages', {
            method: 'DELETE',
            params: {
              ids: [messageId5].join(',')
            }
          });
          assert.equal(200, result.statusCode);
          assert.ok(result.response.data.every(x => x.is_deleted));
        } else {
          console.log('skipping');
        }
        //message = await get_message(messageId);
        //console.log('message after', message);
      });

      it('can get deletes for channel', function() {
        get_deletes(channelId);
      });
      it('can get moderators for channel', async function() {
        result = await overlayApi.serverRequest('loki/v1/channels/1/moderators');
        assert.equal(200, result.statusCode);
      });
      // Moderator only functions
      let modToken
      describe('channel moderator testing', function() {
        it('we have moderator to test with', async function() {
          // now do moderation tests
          modToken = await selectModToken(channelId);
          if (!modToken) {
            console.error('No modToken, skipping moderation tests');
            // all tests should be complete
            //process.exit(0);
            return;
          }
          console.log('Setting modToken to', modToken);
          overlayApi.token = modToken;
        });
        it('mod user info', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          // test token endpoints
          // console.log('token', overlayApi.token);
          const result = await overlayApi.serverRequest('loki/v1/user_info');
          // console.log('mod user_info result', result)
          assert.equal(200, result.statusCode);
          assert.ok(result.response);
          assert.ok(result.response.data);
          assert.ok(result.response.data.moderator_status);
          // || result.response.moderator_status.match(',')
          // I think we only should be global here for now...
          assert.equal(true, result.response.data.moderator_status === true);
          assert.ok(result.response.data.user_id);
          mod_userid=result.response.data.user_id;
        });
        it('user cant demote moderators', async function() {
          overlayApi.token = tokenString; // switch to user
          const result = await overlayApi.serverRequest(`loki/v1/moderators/${mod_userid}`, {
            method: 'DELETE',
          });
          assert.equal(401, result.statusCode);
        });
        it('mod delete test', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          overlayApi.token = modToken; // switch back to mod
          if (modToken && messageId) {
            //let message = await get_message(messageId);
            //console.log('message1', message);
            const result = await overlayApi.serverRequest(`loki/v1/moderation/message/${messageId}`, {
              method: 'DELETE',
            });
            assert.equal(200, result.statusCode);
          } else {
            console.log('skipping modSingleDelete');
          }
        });
        it('get moderators for channel has content', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          result = await overlayApi.serverRequest('loki/v1/channels/1/moderators');
          assert.equal(200, result.statusCode);
          assert.ok(result.response.moderators.length > 0);
        });
        it('mod multi delete test', async function() {
          if (modToken && messageId1 && messageId2) {
            const result = await overlayApi.serverRequest('loki/v1/moderation/messages', {
              method: 'DELETE',
              params: {
                ids: [messageId1, messageId2].join(',')
              }
            });
            assert.equal(200, result.statusCode);
          } else {
            console.log('skipping modMutliDelete');
          }
        });
        it('mod update channel', async function() {
          if (modToken) {
            const chanObj = await platformApi.serverRequest('channels/' + channelId, {
              params: {
                include_annotations: 1,
              }
            });
            if (!chanObj.response.data) {
              console.log('Can not safely test moderatorUpdateChannel, skipping');
              return;
            }
            const result = await overlayApi.serverRequest('loki/v1/channels/' + channelId, {
              method: 'PUT',
              body: chanObj.data
            });
            // why is there two responses..
            //console.log('result', result.response.response.data);
            assert.equal(200, result.statusCode);
            assert.equal(200, result.response.response.meta.code);
            assert.equal(channelId, result.response.response.data.id);
          } else {
            console.log('skipping moderatorUpdateChannel');
          }
        });
      });

      describe('blacklist testing', function() {
        it('make sure token is still valid', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          // test token endpoints
          const result = await overlayApi.serverRequest('loki/v1/user_info');
          //console.log('user user_info result', result)
          assert.equal(200, result.statusCode);
          assert.ok(result.response);
          assert.ok(result.response.data);
        });
        it('blacklist ourself @', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          const result = await overlayApi.serverRequest(`loki/v1/moderation/blacklist/@${ourPubKeyHex}`, {
            method: 'POST',
          });
          assert.equal(200, result.statusCode);
          assert.ok(result.response);
          assert.ok(result.response.data);
        });
        it('blacklist clear', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          const userid = await getUserID(ourPubKeyHex, modToken);
          assert.ok(userid);
          const result = await overlayApi.serverRequest(`loki/v1/moderation/blacklist/@${ourPubKeyHex}`, {
            method: 'DELETE',
          });
          assert.equal(200, result.statusCode);
          assert.ok(result.response);
          assert.ok(result.response.data);
        });
        it('blacklist self by integer id', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          //console.log('key', ourPubKeyHex);
          const userid = await getUserID(ourPubKeyHex, modToken);
          assert.ok(userid);
          //console.log('userid', userid);
          const result = await overlayApi.serverRequest(`loki/v1/moderation/blacklist/${userid}`, {
            method: 'POST',
          });
          //console.log('after blacklist', result);
          assert.equal(200, result.statusCode);
          assert.ok(result.response);
          assert.ok(result.response.data);
        });
        it('switch back to banned user', async function() {
          //console.log('changing back to', tokenString);
          overlayApi.token = tokenString;
        });
        it('banned token vs platform', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          //user_info();
          const result = await platformApi.serverRequest('token');
          // console.log('token for', platformApi.token, result);
          if (disk_config.whitelist) {
            assert.equal(403, result.statusCode);
          } else {
            assert.equal(401, result.statusCode);
          }
        });
        it('banned token vs overlay', async function() {
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          //user_info();
          const result = await overlayApi.serverRequest('loki/v1/user_info');
          // console.log('token for', platformApi.token, result);
          if (disk_config.whitelist) {
            assert.equal(403, result.statusCode);
          } else {
            assert.equal(401, result.statusCode);
          }
        });
        it('try to reregister with banned token', async function() {
          // need to be able to ban it
          if (!modToken) {
            console.log('no mods skipping');
            return;
          }
          const result = await overlayApi.serverRequest('loki/v1/get_challenge', {
            params: {
             pubKey: ourPubKeyHex
            }
          });
          assert.equal(401, result.statusCode);
          //console.log('tokenString', result)
        });
      });
    });
  });
}

// you can't use => with mocha, you'll loose this context
before(async function() {
  //this.timeout(60 * 1000); // can't be in an arrow function
  await ensureUnifiedServer();
  console.log('unified server ready');
})
runIntegrationTests(ourKey, ourPubKeyHex);
