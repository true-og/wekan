/* eslint-env mocha */
// #5847: the passkey server loads in Meteor - @simplewebauthn/server bundled
// and the methods registered. TrueOG turns passkeys off, so they refuse.
import { Meteor } from 'meteor/meteor';
import { expect } from 'chai';

describe('passkeys (runtime)', function () {
  // TrueOG: passkeys are turned off (server/passkeys.js PASSKEYS_DISABLED).
  it('refuses login options while passkeys are disabled', async function () {
    const handler = Meteor.server.method_handlers.passkeyLoginOptions;
    expect(handler, 'passkeyLoginOptions is registered').to.be.a('function');
    let error;
    try { await handler.call({ userId: null }); } catch (e) { error = e; }
    expect(error && error.reason).to.equal('passkeys-disabled');
  });

  it('refuses registration while passkeys are disabled', async function () {
    let error;
    try { await Meteor.server.method_handlers.passkeyRegistrationOptions.call({ userId: 'someone' }); } catch (e) { error = e; }
    expect(error && error.reason).to.equal('passkeys-disabled');
  });
});
