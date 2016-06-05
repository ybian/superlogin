'use strict';
var events = require('events');
var path = require('path');
var PouchDB = require('pouchdb');
var BPromise = require('bluebird');
var Configure = require('../lib/configure');
var User = require('../lib/user');
var Mailer = require('../lib/mailer');
var util = require('../lib/util');
var Session = require('../lib/session');
var seed = require('pouchdb-seed-design');
var request = require('superagent');
var config = require('./test.config.js');

var chai = require('chai');
var sinon = require('sinon');
var expect= chai.expect;
chai.use(require('sinon-chai'));

var dbUrl = util.getDBURL(config.dbServer);

var emitter = new events.EventEmitter();

PouchDB.setMaxListeners(20);

var emailUserForm = {
  username: 'superuser@example2.com',
  password: 'secret',
  confirmPassword: 'secret',
};

var phoneUserForm = {
  username: '13588882222',
  password: 'supercool',
  confirmPassword: 'supercool'
};

var userConfig = new Configure({
  testMode: {
    noEmail: true
  },
  security: {
    defaultRoles: ['user'],
    userActivityLogSize: 3
  },
  local: {
    sendConfirmEmail: false,
    requireEmailConfirm: false,
    usernameKeys: ['email', 'phone']
  },
  mailer: {
    fromEmail: 'noreply@example.com'
  },
  emails: {
    confirmEmail: {
      subject: 'Please confirm your email',
      template: path.join(__dirname, '../templates/email/confirm-email.ejs'),
      format: 'text'
    },
    forgotPassword: {
      subject: 'Your password reset link',
      template: 'templates/email/forgot-password.ejs',
      format: 'text'
    }
  },
  dbServer: {
    protocol: config.dbServer.protocol,
    host: config.dbServer.host,
    user: config.dbServer.user,
    password: config.dbServer.password,
    publicURL: 'https://mydb.example.com',
    typeField: '$type'
  },
  session: {
    adapter: 'file',
    file: {
      sessionsRoot: '.session'
    }
  },
  userDBs: {
    defaultSecurityRoles: {
      admins: ['admin_role'],
      members: ['member_role']
    },
    model: {
      _default: {
        designDocs: ['test'],
        permissions: ['_reader', '_writer', '_replicator']
      }
    },
    defaultDBs: {
      private: ['usertest']
    },
    privatePrefix: 'test',
    designDocDir: __dirname + '/ddocs'
  },
  providers: {
    facebook: {
      clientID: 'FAKE_ID',
      clientSecret: 'FAKE_SECRET',
      callbackURL: 'http://localhost:5000/auth/facebook/callback'
    }
  },
  userModel: {
    static: {
      modelTest: true
    },
    whitelist: ['age', 'zipcode']
  }
});

var req = {
  headers: {
    host: 'example.com'
  },
  protocol: 'http',
  ip: '1.1.1.1'
};

describe('User Model Extra Features', function() {
  var mailer = new Mailer(userConfig);
  var user = new User(userConfig, userDB, keysDB, mailer, emitter);
  var session = new Session(userConfig);
  var userTestDB;
  var previous;
  var verifyEmailToken;
  var userDB, keysDB;

  beforeEach(function() { // 'should prepare the database'
    userDB = new PouchDB(dbUrl + "/superlogin_test_users");
    keysDB = new PouchDB(dbUrl + "/superlogin_test_keys");
    var userDesign = require('../designDocs/user-design');
    userDesign = util.addProvidersToDesignDoc(userConfig, userDesign);
    previous = BPromise.resolve();

    return previous.then(function() {
      return seed(userDB, userDesign);
    });
  });

  afterEach(function() {  // 'should destroy all the test databases'
    return previous.finally(function() {
      var userTestDB1 = new PouchDB(dbUrl + "/test_usertest$superuser");
      var userTestDB2 = new PouchDB(dbUrl + "/test_usertest$misterx");
      var userTestDB3 = new PouchDB(dbUrl + "/test_usertest$misterx3");
      var userTestDB4 = new PouchDB(dbUrl + "/test_superdb");
      return BPromise.all([userDB.destroy(), keysDB.destroy(), userTestDB1.destroy(), userTestDB2.destroy(), userTestDB3.destroy(), userTestDB4.destroy()]);
    });
  });

  it('should create a new user with uuid as _id', function() {
    return previous
      .then(function() {
        userConfig.setItem('local.uuidAsId', true);
        user = new User(userConfig, userDB, keysDB, mailer, emitter);
        return user.create(emailUserForm, req);
      })
      .then(function(newUser) {
        expect(newUser.username).to.equal(emailUserForm.username);
        expect(newUser.email).to.equal(emailUserForm.username);
        expect(newUser._id.length).to.equal(32); //uuid
      });
  });

  it('should create a new user with username renamded to _id', function() {
    return previous
      .then(function() {
        userConfig.setItem('local.uuidAsId', false);
        user = new User(userConfig, userDB, keysDB, mailer, emitter);
        return user.create(emailUserForm, req);
      })
      .then(function(newUser) {
        expect(newUser.username).to.equal(undefined);
        expect(newUser.email).to.equal(emailUserForm.username);
        expect(newUser._id).to.equal(emailUserForm.username);
      });
  });

  it('should allow registration with invite code', function() {
    var code, userId;

    return previous
      .then(function() {
        userConfig.setItem('security.inviteOnlyRegistration', true);
        code = PouchDB.utils.uuid(32, 16).toLowerCase();
        userId = PouchDB.utils.uuid(32, 16).toLowerCase();
        return session._adapter.storeKey('invite_code:' + code, 10000, userId);
      })
      .then(function() {
        user = new User(userConfig, userDB, keysDB, mailer, emitter);
        emailUserForm.inviteCode = code;
        return user.create(emailUserForm, req);
      })
      .then(function(newUser) {
        expect(newUser._id).to.equal(userId);
        expect(newUser.email).to.equal(emailUserForm.username);
      });
  });

  it('should not allow registration without invite code', function() {
    var code, userId;

    return previous
      .then(function() {
        userConfig.setItem('security.inviteOnlyRegistration', true);
        code = PouchDB.utils.uuid(32, 16).toLowerCase();
        userId = PouchDB.utils.uuid(32, 16).toLowerCase();
      })
      .then(function() {
        user = new User(userConfig, userDB, keysDB, mailer, emitter);
        emailUserForm.inviteCode = code;
        return user.create(emailUserForm, req);
      })
      .then(function() {
        throw new Error('Should not allow registration');
      })
      .catch(function(err) {
        if(err.validationErrors) {
          expect(err.validationErrors).to.equal('invite code required');
        } else {
          throw err;
        }
      });
  });

  it('should allow change email', function() {
    var code, userId;

    return previous
      .then(function() {
        userConfig.setItem('security.inviteOnlyRegistration', false);
        user = new User(userConfig, userDB, keysDB, mailer, emitter);
        return user.create(emailUserForm, req);
      })
      .then(function(newUser) {
        return user.changeEmail(newUser._id, 'newEmail@example.com');
      })
      .then(function(result) {
        expect(result.ok).to.equal(true);
      });
  });

  it('should not allow change email to null if email is the only credential', function() {
    var code, userId;

    return previous
      .then(function() {
        user = new User(userConfig, userDB, keysDB, mailer, emitter);
        return user.create(emailUserForm, req);
      })
      .then(function(newUser) {
        return user.changeEmail(newUser._id, '');
      })
      .then(function(result) {
        throw new Error('Should not allow set email to null');
      })
      .catch(function(err) {
        expect(err.message).to.equal('You cannot set your only login credential to null!');
      });
  });
});
