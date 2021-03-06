'use strict';

var url = require('url');
var BPromise = require('bluebird');
var Model = require('sofa-model');
var nodemailer = require('nodemailer');
var extend = require('extend');
var PouchDB = require('pouchdb');
var Session = require('./session');
var util = require('./util');
var DBAuth = require('./dbauth');

// regexp from https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L4
var EMAIL_REGEXP = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}$/;
var USER_REGEXP = /^.{3,16}$/;

var inviteCodePrefix = 'invite_code';

module.exports = function (config, userDB, couchAuthDB, mailer, emitter) {

  var self = this;
  var dbAuth = new DBAuth(config, userDB, couchAuthDB);
  var session = new Session(config);
  var onCreateActions = [];
  var onLinkActions = [];

  // Token valid for 24 hours by default
  // Forget password token life
  var tokenLife = config.getItem('security.tokenLife') || 86400;
  // Session token life
  var sessionLife = config.getItem('security.sessionLife') || 86400;

  var emailUsername = config.getItem('local.emailUsername');
  var usernameKeys = config.getItem('local.usernameKeys');
  var usernameField = config.getItem('local.usernameField') || 'username';
  if (!usernameKeys || usernameKeys.length === 0) {
    usernameKeys = ['username'];
  }
  var PHONE_REGEXP = config.getItem('local.phoneRegexp') || /^1[0-9]{10}/;
  var inviteOnly = config.getItem('security.inviteOnlyRegistration');

  this.validateUsername = function (username) {
    if (!username) {
      return BPromise.resolve();
    }
    if (usernameKeys.indexOf('username') >= 0) {
      if (!username.match(USER_REGEXP)) {
        return BPromise.resolve('invalid username');
      }

      return userDB.query('auth/username', {key: username})
        .then(function (result) {
          if (result.rows.length === 0) {
            // Pass!
            return BPromise.resolve();
          }
          else {
            return BPromise.resolve('already in use');
          }
        }, function (err) {
          throw new Error(err);
        });
    }

    return BPromise.resolve();
  };

  this.validateEmail = function (email) {
    if (!email) {
      return BPromise.resolve();
    }
    if (!email.match(EMAIL_REGEXP)) {
      return BPromise.resolve('invalid email');
    }

    if (usernameKeys.indexOf('email') >= 0) {
      return userDB.query('auth/email', {key: email})
        .then(function (result) {
          if (result.rows.length === 0) {
            // Pass!
            return BPromise.resolve();
          }
          else {
            return BPromise.resolve('already in use');
          }
        }, function (err) {
          throw new Error(err);
        });
    }

    return BPromise.resolve();
  };

  this.validatePhone = function (phone) {
    if (!phone) {
      return BPromise.resolve();
    }
    if (!phone.match(PHONE_REGEXP)) {
      return BPromise.resolve('invalid phone');
    }

    if (usernameKeys.indexOf('phone') >= 0) {
      return userDB.query('auth/phone', {key: phone})
        .then(function (result) {
          if (result.rows.length === 0) {
            return BPromise.resolve();
          }
          else {
            return BPromise.resolve('already in use');
          }
        }, function (err) {
          throw new Error(err);
        });
    }

    return BPromise.resolve();
  };

  // Validation function for ensuring that two fields match
  this.matches = function(value, option, key, attributes) {
    if (attributes && attributes[option] !== value) {
      return "does not match " + option;
    }
  };

  var passwordConstraints = {
    presence: true,
    length: {
      minimum: 6,
      message: "must be at least 6 characters"
    },
    matches: 'confirmPassword'
  };

  var userModel = {
    async: true,
    whitelist: [
      'name',
      'username',
      'email',
      'phone',
      'password',
      'confirmPassword',
      'inviteCode'
    ],
    customValidators: {
      validateEmail: self.validateEmail,
      validatePhone: self.validatePhone,
      validateUsername: self.validateUsername,
      matches: self.matches
    },
    sanitize: {
      name: ['trim'],
      username: ['trim'],
      email: ['trim', 'toLowerCase'],
      phone: ['trim']
    },
    validate: {
      email: {
        validateEmail: true
      },
      phone: {
        validatePhone: true
      },
      username: {
        validateUsername: true
      },
      password: passwordConstraints,
      confirmPassword: {
        presence: true
      }
    },
    static: {
      roles: config.getItem('security.defaultRoles'),
      providers: ['local']
    },
    rename: {
      username: '_id'
    }
  };

  userModel.static[config.getItem('dbServer.typeField')] = 'user';
  if (config.getItem('local.uuidAsId')) {
    delete userModel.rename;
  }

  var resetPasswordModel = {
    async: true,
    customValidators: {
      matches: self.matches
    },
    validate: {
      token: {
        presence: true
      },
      password: passwordConstraints,
      confirmPassword: {
        presence: true
      }
    }
  };

  var resetPasswordModel2 = {
    async: true,
    customValidators: {
      matches: self.matches
    },
    validate: {
      password: passwordConstraints,
      confirmPassword: {
        presence: true
      },
      username: {
        presence: true
      }
    }
  };

  var changePasswordModel = {
    async: true,
    customValidators: {
      matches: self.matches
    },
    validate: {
      newPassword: passwordConstraints,
      confirmPassword: {
        presence: true
      }
    }
  };

  this.onCreate = function(fn) {
    if(typeof fn === 'function') {
      onCreateActions.push(fn);
    } else {
      throw new TypeError('onCreate: You must pass in a function');
    }
  };

  this.onLink = function(fn) {
    if(typeof fn === 'function') {
      onLinkActions.push(fn);
    } else {
      throw new TypeError('onLink: You must pass in a function');
    }
  };

  function processTransformations(fnArray, userDoc, provider) {
    var promise;
    fnArray.forEach(function(fn) {
      if(!promise) {
        promise = fn.call(null, userDoc, provider);
      } else {
        if(!promise.then || typeof promise.then !== 'function') {
          throw new Error('onCreate function must return a promise');
        }
        promise.then(function(newUserDoc) {
          return fn.call(null, newUserDoc, provider);
        });
      }
    });
    if(!promise) {
      promise = BPromise.resolve(userDoc);
    }
    return promise;
  }

  function processInviteCode(userDoc) {
    if (!inviteOnly) {
      return BPromise.resolve(userDoc);
    }

    var key = inviteCodePrefix + ':' + userDoc.inviteCode;
    return session._adapter.getKey(key)
      .then(function(result) {
        if(result) {
          session._adapter.deleteKeys([key]);
          delete userDoc.inviteCode;
          if (result.length == 32) { // Treat as couch uuid
            userDoc._id = result;
          }
          return BPromise.resolve(userDoc);
        } else {
          return BPromise.reject({
            key: 'missing_invite_code',
            message: 'invite code required'
          });
        }
      }, function() {
        return BPromise.reject({
          key: 'missing_invite_code',
          message: 'invite code required'
        });
      });
  }

  // Detect login type ('email', 'phone' or 'username')
  function loginType(login) {
    var query = null;
    for (var i = 0; i < usernameKeys.length; i++) {
      var key = usernameKeys[i];
      if (key == 'email' && EMAIL_REGEXP.test(login)) {
        query = 'email';
        break;
      }
      if (key == 'phone' && PHONE_REGEXP.test(login)) {
        query = 'phone';
        break;
      }
    }
    if (!query) {
      query = 'username';
    }
    return query;
  }

  this.get = function (login) {
    var query = loginType(login);

    return userDB.query('auth/' + query, {key: login, include_docs: true})
      .then(function (results) {
        if (results.rows.length > 0) {
          return BPromise.resolve(results.rows[0].doc);
        } else {
          return BPromise.resolve(null);
        }
      });
  };

  this.create = function (form, req) {
    var login = form[usernameField];
    if (login) {
      var type = loginType(login);
      form[type] = login;
    }
    req = req || {};
    var finalUserModel = userModel;
    var newUserModel = config.getItem('userModel');
    if(typeof newUserModel === 'object') {
      var whitelist;
      if(newUserModel.whitelist) {
        whitelist = util.arrayUnion(userModel.whitelist, newUserModel.whitelist);
      }
      finalUserModel = extend(true, {}, userModel, config.getItem('userModel'));
      finalUserModel.whitelist = whitelist || finalUserModel.whitelist;
    }
    var UserModel = new Model(finalUserModel);
    var user = new UserModel(form);
    var newUser;
    return user.process()
      .catch(function(err) {
        return BPromise.reject({error: 'Validation failed', validationErrors: err, status: 400});
      })
      .then(function(userDoc) {
        return processInviteCode(userDoc);
      })
      .then(function (userDoc) {
        newUser = userDoc;
        if (!newUser._id) {
          newUser._id = PouchDB.utils.uuid(32, 16).toLowerCase();
        }
        if(config.getItem('local.sendConfirmEmail')) {
          newUser.unverifiedEmail = {
            email: newUser.email,
            token: util.URLSafeUUID()
          };
          delete newUser.email;
        }
        return util.hashPassword(newUser.password);
      }, function(err) {
        return BPromise.reject(err);
      })
      .then(function (hash) {
        // Store password hash
        newUser.local = {};
        newUser.local.salt = hash.salt;
        newUser.local.derived_key = hash.derived_key;
        delete newUser.password;
        delete newUser.confirmPassword;
        newUser.signUp = {
          provider: 'local',
          timestamp: new Date().toISOString(),
          ip: req.ip
        };
        return addUserDBs(newUser);
      })
      .then(function(newUser) {
        return self.logActivity(newUser._id, 'signup', 'local', req, newUser);
      })
      .then(function(newUser) {
        return processTransformations(onCreateActions, newUser, 'local');
      })
      .then(function(finalNewUser) {
        return userDB.post(finalNewUser);
      })
      .then(function(result) {
        newUser._id = result.id;
        newUser._rev = result.rev;
        if(!config.getItem('local.sendConfirmEmail')) {
          return BPromise.resolve();
        }
        return mailer.sendEmail('confirmEmail', newUser.unverifiedEmail.email, {req: req, user: newUser});
      })
      .then(function () {
        emitter.emit('signup', newUser, 'local');
        return BPromise.resolve(newUser);
      });
  };

  this.socialAuth = function(provider, auth, profile, req) {
    var user;
    var newAccount = false;
    var action;
    var baseUsername;
    req = req || {};
    var ip = req.ip;
    // It is important that we return a Bluebird promise so oauth.js can call .nodeify()
    return BPromise.resolve()
      .then(function() {
        return userDB.query('auth/' + provider, {key: profile.id, include_docs: true});
      })
      .then(function(results) {
        if (results.rows.length > 0) {
          user = results.rows[0].doc;
          return BPromise.resolve();
        } else {
          if (inviteOnly) {
            return processInviteCode({ inviteCode: req.query.inviteCode });
          } else {
            return BPromise.resolve({});
          }
        }
      })
      .then(function(userDoc) {
        if (!userDoc)
          return BPromise.resolve();

        newAccount = true;
        user = userDoc;
        user[provider] = {};
        if(profile.emails) {
          user.email = profile.emails[0].value;
        }
        user.providers = [provider];
        user[config.getItem('dbServer.typeField')] = 'user';
        user.roles = config.getItem('security.defaultRoles');
        user.signUp = {
          provider: provider,
          timestamp: new Date().toISOString(),
          ip: ip
        };
        var emailFail = function() {
          return BPromise.reject({
            error: 'Email already in use',
            key: 'inuse_email_link',
            message: 'Your email is already in use. Try signing in first and then linking this account.',
            status: 409
          });
        };
        // Now we need to generate a username
        if(profile.username) {
          baseUsername = profile.username.toLowerCase();
        } else {
          // If a username isn't specified we'll take it from the email
          if(user.email) {
            var parseEmail = user.email.split('@');
            baseUsername = parseEmail[0].toLowerCase();
          } else if(profile.displayName) {
            baseUsername = profile.displayName.replace(/\s/g, '').toLowerCase();
          } else {
            baseUsername = profile.id.toLowerCase();
          }
        }
        return self.validateEmail(user.email)
          .then(function(err) {
            if(err) {
              return emailFail();
            }
            return generateUsername(baseUsername);
          });
      })
      .then(function(finalUsername) {
        if (!user._id) {
          if (finalUsername && !config.getItem('local.uuidAsId')) {
            user._id = finalUsername;
          } else {
            user._id = PouchDB.utils.uuid(32, 16).toLowerCase();
          }
        }
        user[provider].auth = auth;
        user[provider].profile = profile;
        if(!user.name) {
          user.name = profile.displayName;
        }
        delete user[provider].profile._raw;
        if(newAccount) {
          return addUserDBs(user);
        } else {
          return BPromise.resolve(user);
        }
      })
      .then(function(userDoc) {
        action = newAccount ? 'signup' : 'login';
        return self.logActivity(userDoc._id, action, provider, req, userDoc);
      })
      .then(function(userDoc) {
        if(newAccount) {
          return processTransformations(onCreateActions, userDoc, provider);
        } else {
          return processTransformations(onLinkActions, userDoc, provider);
        }
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      })
      .then(function() {
        if(action === 'signup') {
          emitter.emit('signup', user, provider);
        }
        return BPromise.resolve(user);
      });
  };

  this.linkSocial = function(user_id, provider, auth, profile, req) {
    req = req || {};
    var user;
    // Load user doc
    return BPromise.resolve()
      .then(function() {
        return userDB.query('auth/' + provider, {key: profile.id});
      })
      .then(function(results) {
        if(results.rows.length === 0) {
          return BPromise.resolve();
        } else {
          if(results.rows[0].id !== user_id) {
            return BPromise.reject({
              error: 'Conflict',
              key: 'inuse_' + provider,
              message: 'This ' + provider + ' profile is already in use by another account.',
              status: 409
            });
          }
        }
      })
      .then(function() {
        return userDB.get(user_id);
      })
      .then(function(theUser) {
        user = theUser;
        // Check for conflicting provider
        if(user[provider] && (user[provider].profile.id !== profile.id)) {
          return BPromise.reject({
            error: 'Conflict',
            key: 'conflict_' + provider,
            message: 'Your account is already linked with another ' + provider + 'profile.',
            status: 409
          });
        }
        // Check email for conflict
        if(!profile.emails) {
          return BPromise.resolve({rows: []});
        }
        if(emailUsername) {
          return userDB.query('auth/emailUsername', {key: profile.emails[0].value});
        } else {
          return userDB.query('auth/email', {key: profile.emails[0].value});
        }
      })
      .then(function(results) {
        var passed;
        if(results.rows.length === 0) {
          passed = true;
        } else {
          passed = true;
          results.rows.forEach(function(row) {
            if(row.id !== user_id) {
              passed = false;
            }
          });
        }
        if(!passed) {
          return BPromise.reject({
            error: 'Conflict',
            key: 'inuse_email',
            message: 'The email ' + profile.emails[0].value + ' is already in use by another account.',
            status: 409
          });
        } else {
          return BPromise.resolve();
        }
      })
      .then(function() {
        // Insert provider info
        user[provider] = {};
        user[provider].auth = auth;
        user[provider].profile = profile;
        if(!user.providers) {
          user.providers = [];
        }
        if(user.providers.indexOf(provider) === -1) {
          user.providers.push(provider);
        }
        if(!user.name) {
          user.name = profile.displayName;
        }
        delete user[provider].profile._raw;
        return self.logActivity(user._id, 'link', provider, req, user);
      })
      .then(function(userDoc) {
        return processTransformations(onLinkActions, userDoc, provider);
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      })
      .then(function() {
        return BPromise.resolve(user);
      });
  };

  this.unlink = function(user_id, provider) {
    var user;
    return userDB.get(user_id)
      .then(function(theUser) {
        user = theUser;
        if(!provider) {
          return BPromise.reject({
            error: 'Unlink failed',
            key: 'missing_provider_to_unlink',
            message: 'You must specify a provider to unlink.',
            status: 400
          });
        }
        // We can only unlink if there are at least two providers
        if(!user.providers || !(user.providers instanceof Array) || user.providers.length < 2) {
          return BPromise.reject({
            error: 'Unlink failed',
            key: 'unlink_only_provider',
            message: 'You can\'t unlink your only provider!',
            status: 400
          });
        }
        // We cannot unlink local
        if(provider === 'local') {
          return BPromise.reject({
            error: 'Unlink failed',
            key: 'unlink_local',
            message: 'You can\'t unlink local.',
            status: 400
          });
        }
        // Check that the provider exists
        if(!user[provider] || typeof user[provider] !== 'object') {
          return BPromise.reject({
            error: 'Unlink failed',
            key: 'provider_not_found',
            message: 'Provider: ' + util.capitalizeFirstLetter(provider) + ' not found.',
            status: 404
          });
        }
        delete user[provider];
        // Remove the unlinked provider from the list of providers
        user.providers.splice(user.providers.indexOf(provider), 1);
        return userDB.put(user);
      })
      .then(function() {
        return BPromise.resolve(user);
      });
  };

  this.createSession = function(user_id, provider, req) {
    var user;
    var newToken;
    var newSession;
    var password;
    req = req || {};
    var ip = req.ip;
    return userDB.get(user_id)
      .then(function(record) {
        user = record;
        return generateSession(user._id, user.roles);
      })
      .then(function(token) {
        password = token.password;
        newToken = token;
        newToken.provider = provider;
        return session.storeToken(newToken);
      })
      .then(function() {
        return dbAuth.storeKey(user_id, newToken.key, password, newToken.expires, user.roles);
      })
      .then(function() {
        // authorize the new session across all dbs
        if(!user.personalDBs) {
          return BPromise.resolve();
        }
        return dbAuth.authorizeUserSessions(user_id, user.personalDBs, newToken.key, user.roles);
      })
      .then(function() {
        if(!user.session) {
          user.session = {};
        }
         newSession = {
          issued: newToken.issued,
          expires: newToken.expires,
          provider: provider,
          ip: ip
        };
        user.session[newToken.key] = newSession;
        // Clear any failed login attempts
        if(provider === 'local') {
          if(!user.local) user.local = {};
          user.local.failedLoginAttempts = 0;
          delete user.local.lockedUntil;
        }
        return self.logActivity(user._id, 'login', provider, req, user);
      })
      .then(function(userDoc) {
        // Clean out expired sessions on login
        return self.logoutUserSessions(userDoc, 'expired');
      })
      .then(function(finalUser) {
        user = finalUser;
        return userDB.put(finalUser);
      })
      .then(function() {
        newSession.token = newToken.key;
        newSession.password = password;
        newSession.user_id = user._id;
        newSession.user_email = user.email;
        newSession.user_phone = user.phone;
        newSession.roles = user.roles;
        // Inject the list of userDBs
        if(typeof user.personalDBs === 'object') {
          var userDBs = {};
          var publicURL;
          if(config.getItem('dbServer.publicURL')) {
            var dbObj = url.parse(config.getItem('dbServer.publicURL'));
            dbObj.auth = newSession.token + ':' + newSession.password;
            publicURL = dbObj.format();
          } else {
            publicURL = config.getItem('dbServer.protocol') + newSession.token + ':' + newSession.password + '@' +
              config.getItem('dbServer.host') + '/';
          }
          Object.keys(user.personalDBs).forEach(function(finalDBName) {
            userDBs[user.personalDBs[finalDBName].name] = publicURL + finalDBName;
          });
          newSession.userDBs = userDBs;
        }

        var profile = user.profile || {};

        var profileMapping = config.getItem('session.profileMapping');
        if (profileMapping) {
          for (var field in profileMapping) {
            if (!profile[field]) {
              var mapping = profileMapping[field];
              for (var p in mapping) {
                var providerField = mapping[p];
                if (!user[p])
                  break;
                var providerProfile = user[p].profile;
                if (providerProfile && providerProfile[providerField]) {
                  profile[field] = providerProfile[providerField];
                  break;
                }
              }
            }
          }
        }

        newSession.profile = profile;

        emitter.emit('login', newSession, provider);
        return BPromise.resolve(newSession, provider);
      });
  };

  this.handleFailedLogin = function(user, req) {
    req = req || {};
    var maxFailedLogins = config.getItem('security.maxFailedLogins');
    if(!maxFailedLogins) {
      return BPromise.resolve();
    }
    if(!user.local) {
      user.local = {};
    }
    if(!user.local.failedLoginAttempts) {
      user.local.failedLoginAttempts = 0;
    }
    user.local.failedLoginAttempts++;
    if(user.local.failedLoginAttempts > maxFailedLogins) {
      // user.local.failedLoginAttempts = 0;
      user.local.lockedUntil = Date.now() + config.getItem('security.lockoutTime') * 1000;
    }
    return self.logActivity(user._id, 'failed login', 'local', req, user)
      .then(function(finalUser) {
        return userDB.put(finalUser);
      })
      .then(function() {
        return BPromise.resolve(!!user.local.lockedUntil);
      });
  };

  this.logActivity = function(user_id, action, provider, req, userDoc, saveDoc) {
    var logSize = config.getItem('security.userActivityLogSize');
    if(!logSize) {
      return BPromise.resolve(userDoc);
    }
    var promise;
    if(userDoc) {
      promise = BPromise.resolve(userDoc);
    } else {
      if(saveDoc !== false) {
        saveDoc = true;
      }
      promise = userDB.get(user_id);
    }
    return promise
      .then(function(theUser) {
        userDoc = theUser;
        if(!userDoc.activity || !(userDoc.activity instanceof Array)) {
          userDoc.activity = [];
        }
        var entry = {
          timestamp: new Date().toISOString(),
          action: action,
          provider: provider,
          ip: req.ip
        };
        userDoc.activity.unshift(entry);
        while(userDoc.activity.length > logSize) {
          userDoc.activity.pop();
        }
        if(saveDoc) {
          return userDB.put(userDoc)
            .then(function() {
              return BPromise.resolve(userDoc);
            });
        } else {
          return BPromise.resolve(userDoc);
        }
      });
  };

  this.refreshSession = function (key) {
    var newSession;
    return session.fetchToken(key)
      .then(function(oldToken) {
        newSession = oldToken;
        var now = Date.now();
        newSession.issued = now;
        newSession.expires = now + sessionLife * 1000;
        return BPromise.all([
          userDB.get(newSession._id),
          session.storeToken(newSession)
        ]);
      })
      .then(function(results) {
        var userDoc = results[0];
        userDoc.session[key].expires = newSession.expires;
        // Clean out expired sessions on refresh
        return self.logoutUserSessions(userDoc, 'expired');
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      })
      .then(function() {
        delete newSession.password;
        newSession.token = newSession.key;
        delete newSession.key;
        newSession.user_id = newSession._id;
        delete newSession._id;
        delete newSession.salt;
        delete newSession.derived_key;
        emitter.emit('refresh', newSession);
        return BPromise.resolve(newSession);
      });
  };

  this.resetPassword = function (form, req) {
    req = req || {};
    var ResetPasswordModel = new Model(resetPasswordModel);
    var passwordResetForm = new ResetPasswordModel(form);
    var user;
    return passwordResetForm.validate()
      .then(function () {
        var tokenHash = util.hashToken(form.token);
        return userDB.query('auth/passwordReset', {key: tokenHash, include_docs: true});
      }, function(err) {
        return BPromise.reject({
          error: 'Validation failed',
          validationErrors: err,
          status: 400
        });
      })
      .then(function (results) {
        if (!results.rows.length) {
          return BPromise.reject({status: 400, key: 'invalid_token', error: 'Invalid token'});
        }
        user = results.rows[0].doc;
        if(user.forgotPassword.expires < Date.now()) {
          return BPromise.reject({status: 400, key: 'expired_token', error: 'Token expired'});
        }
        return util.hashPassword(form.password);
      })
      .then(function(hash) {
        if(!user.local) {
          user.local = {};
        }
        user.local.salt = hash.salt;
        user.local.derived_key = hash.derived_key;
        if(user.providers.indexOf('local') === -1) {
          user.providers.push('local');
        }
        // logout user completely
        return self.logoutUserSessions(user, 'all');
      })
      .then(function(userDoc) {
        user = userDoc;
        delete user.forgotPassword;
        return self.logActivity(user._id, 'reset password', 'local', req, user);
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      })
      .then(function() {
        emitter.emit('password-reset', user);
        return BPromise.resolve(user);
      });
  };

  // Reset password with security token verified outside
  this.resetPassword2 = function (form, req) {
    req = req || {};
    var self = this;
    var ResetPasswordModel = new Model(resetPasswordModel2);
    var passwordResetForm = new ResetPasswordModel(form);
    var user;
    return passwordResetForm.validate()
      .then(function () {
        return self.get(form.username);
      }, function(err) {
        return BPromise.reject({
          error: 'Validation failed',
          validationErrors: err,
          status: 400
        });
      })
      .then(function (userDoc) {
        if (userDoc) {
          user = userDoc;
          return self.changePassword(user._id, form.password, user, req);
        } else {
          return BPromise.reject({
            error: 'Password reset failed',
            key: 'username_not_found',
            message: 'No user with that username exists',
            status: 400
          });
        }
      })
      .then(function() {
        emitter.emit('password-reset', user);
        return BPromise.resolve(user);
      });
  };

  this.changePasswordSecure = function(user_id, form, req) {
    req = req || {};
    var self = this;
    var ChangePasswordModel = new Model(changePasswordModel);
    var changePasswordForm = new ChangePasswordModel(form);
    var user;
    return changePasswordForm.validate()
      .then(function () {
        return userDB.get(user_id);
      }, function(err) {
        return BPromise.reject({error: 'Validation failed', validationErrors: err, status: 400});
      })
      .then(function() {
        return userDB.get(user_id);
      })
      .then(function(userDoc) {
        user = userDoc;
        if(user.local && user.local.salt && user.local.derived_key) {
          // Password is required
          if(!form.currentPassword){
            return BPromise.reject({
              error: 'Password change failed',
              key: 'missing_current_passowrd',
              message: 'You must supply your current password in order to change it.',
              status: 400
            });
          }
          return util.verifyPassword(user.local, form.currentPassword);
        } else {
          return BPromise.resolve();
        }
      })
      .then(function() {
        return self.changePassword(user._id, form.newPassword, user, req);
      }, function(err) {
        return BPromise.reject(err || {
          error: 'Password change failed',
          key: 'invalid_current_password',
          message: 'The current password you supplied is incorrect.',
          status: 400
        });
      })
      .then(function() {
        if(req.user && req.user.key) {
          return self.logoutOthers(req.user.key);
        } else {
          return BPromise.resolve();
        }
      });
  };

  this.changePassword = function(user_id, newPassword, userDoc, req) {
    req = req || {};
    var promise, user;
    if (userDoc) {
      promise = BPromise.resolve(userDoc);
    } else {
      promise = userDB.get(user_id);
    }
    return promise
      .then(function(doc) {
        user = doc;
        return util.hashPassword(newPassword);
      }, function(err) {
        return BPromise.reject({
          error: 'User not found',
          key: 'username_not_found',
          status: 404
        });
      })
      .then(function(hash) {
        if(!user.local) {
          user.local = {};
        }
        user.local.salt = hash.salt;
        user.local.derived_key = hash.derived_key;
        if(user.providers.indexOf('local') === -1) {
          user.providers.push('local');
        }
        return self.logActivity(user._id, 'changed password', 'local', req, user);
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      })
      .then(function() {
        emitter.emit('password-change', user);
      });
  };

  this.forgotPassword = function(email, req) {
    req = req || {};
    var user, token, tokenHash;
    return userDB.query('auth/email', {key: email, include_docs: true})
      .then(function(result) {
        if(!result.rows.length) {
          return BPromise.reject({
            error: 'User not found',
            key: 'username_not_found',
            status: 404
          });
        }
        user = result.rows[0].doc;
        token = util.URLSafeUUID();
        tokenHash = util.hashToken(token);
        user.forgotPassword = {
          token: tokenHash, // Store secure hashed token
          issued: Date.now(),
          expires: Date.now() + tokenLife * 1000
        };
        return self.logActivity(user._id, 'forgot password', 'local', req, user);
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      })
      .then(function() {
        return mailer.sendEmail('forgotPassword', user.email || user.unverifiedEmail.email,
          {user: user, req: req, token: token}); // Send user the unhashed token
      }).then(function() {
        emitter.emit('forgot-password', user);
        return BPromise.resolve(user.forgotPassword);
      });
  };

  this.verifyEmail = function(token, req) {
    req = req || {};
    var user;
    return userDB.query('auth/verifyEmail', {key: token, include_docs: true})
      .then(function(result) {
        if(!result.rows.length) {
          return BPromise.reject({error: 'Invalid token', key: 'invalidToken', status: 400});
        }
        user = result.rows[0].doc;
        user.email = user.unverifiedEmail.email;
        delete user.unverifiedEmail;
        emitter.emit('email-verified', user);
        return self.logActivity(user._id, 'verified email', 'local', req, user);
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      });
  };

  this.changeEmail = function(user_id, newEmail, req) {
    req = req || {};
    if(!req.user) {
      req.user = {provider: 'local'};
    }
    var user;
    return self.validateEmail(newEmail)
      .then(function(err) {
        if(err) {
          return BPromise.reject({
            error: 'Validation failed',
            validationErrors: { email: [err] },
            status: 400
          });
        }
        return userDB.get(user_id);
      })
      .then(function(userDoc) {
        if (!newEmail && isOnlyUsernameKey('email', userDoc)) {
          return BPromise.reject({
            error: 'Email changed failed',
            key: 'only_login_credential',
            message: 'You cannot set your only login credential to null!',
            status: 400
          });
        }

        if (!userDoc.local) {
          return BPromise.reject({
            error: 'Email changed failed',
            key: 'password_not_set',
            message: 'You must set your password first!',
            status: 400
          });
        }

        return userDoc;
      })
      .then(function(userDoc) {
        user = userDoc;
        if(config.getItem('local.sendConfirmEmail')) {
          user.unverifiedEmail = {
            email: newEmail,
            token: util.URLSafeUUID()
          };
          return mailer.sendEmail('confirmEmail', user.unverifiedEmail.email, {req: req, user: user});
        } else {
          user.email = newEmail;
          return BPromise.resolve();
        }
      })
      .then(function() {
        emitter.emit('email-changed', user);
        return self.logActivity(user._id, 'changed email', req.user.provider, req, user);
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      });
  };

  this.changePhone = function(user_id, newPhone, req) {
    req = req || {};
    if(!req.user) {
      req.user = {provider: 'local'};
    }
    var user;
    return self.validatePhone(newPhone)
      .then(function(err) {
        if(err) {
          return BPromise.reject({
            error: 'Validation failed',
            validationErrors: { phone: [err] },
            status: 400
          });
        }
        return userDB.get(user_id);
      })
      .then(function(userDoc) {
        if (!newPhone && isOnlyUsernameKey('phone', userDoc)) {
          return BPromise.reject({
            error: 'Phone changed failed',
            key: 'only_login_credential',
            message: 'You cannot set your only login credential to null!',
            status: 400
          });
        }

        if (!userDoc.local) {
          return BPromise.reject({
            error: 'Phone changed failed',
            key: 'password_not_set',
            message: 'You must set your password first!',
            status: 400
          });
        }

        return userDoc;
      })
      .then(function(userDoc) {
        user = userDoc;
        user.phone = newPhone;
        return BPromise.resolve();
      })
      .then(function() {
        emitter.emit('phone-changed', user);
        return self.logActivity(user._id, 'changed phone', req.user.provider, req, user);
      })
      .then(function(finalUser) {
        return userDB.put(finalUser);
      });
  };

  this.addUserDB = function(user_id, dbName, type, designDocs, permissions) {
    var userDoc;
    var dbConfig = dbAuth.getDBConfig(dbName, type || 'private');
    dbConfig.designDocs = designDocs || dbConfig.designDocs || '';
    dbConfig.permissions = permissions || dbConfig.permissions;
    return userDB.get(user_id)
      .then(function(result) {
        userDoc = result;
        return dbAuth.addUserDB(userDoc, dbName, dbConfig.designDocs, dbConfig.type, dbConfig.permissions,
          dbConfig.adminRoles, dbConfig.memberRoles);
      })
      .then(function(finalDBName) {
        if(!userDoc.personalDBs) {
          userDoc.personalDBs = {};
        }
        delete dbConfig.designDocs;
        // If permissions is specified explicitly it will be saved, otherwise will be taken from defaults every session
        if(!permissions) {
          delete dbConfig.permissions;
        }
        delete dbConfig.adminRoles;
        delete dbConfig.memberRoles;
        userDoc.personalDBs[finalDBName] = dbConfig;
        emitter.emit('user-db-added', user_id, dbName);
        return userDB.put(userDoc);
      });
  };

  this.removeUserDB = function(user_id, dbName, deletePrivate, deleteShared) {
    var user;
    var update = false;
    return userDB.get(user_id)
      .then(function(userDoc) {
        user = userDoc;
        if(user.personalDBs && typeof user.personalDBs === 'object') {
          Object.keys(user.personalDBs).forEach(function(db) {
            if(user.personalDBs[db].name === dbName) {
              var type = user.personalDBs[db].type;
              delete user.personalDBs[db];
              update = true;
              if(type === 'private' && deletePrivate) {
                return dbAuth.removeDB(dbName);
              }
              if(type === 'shared' && deleteShared) {
                return dbAuth.removeDB(dbName);
              }
            }
          });
        }
        return BPromise.resolve();
      })
      .then(function() {
        if(update) {
          emitter.emit('user-db-removed', user_id, dbName);
          return userDB.put(user);
        }
        return BPromise.resolve();
      });
  };

  this.logoutUser = function(user_id, session_id) {
    var promise, user;
    if(user_id) {
      promise = userDB.get(user_id);
    } else {
      if(!session_id) {
        return BPromise.reject({
          error: 'unauthorized',
          key: 'unauthorized',
          message: 'Either user_id or session_id must be specified',
          status: 401
        });
      }
      promise = userDB.query('auth/session', {key: session_id, include_docs: true})
        .then(function(results) {
          if(!results.rows.length) {
            return BPromise.reject({
              error: 'unauthorized',
              key: 'unauthorized',
              status: 401
            });
          }
          return BPromise.resolve(results.rows[0].doc);
        });
    }
    return promise
      .then(function(record) {
        user = record;
        user_id = record._id;
        return self.logoutUserSessions(user, 'all');
      })
      .then(function() {
        emitter.emit('logout', user_id);
        emitter.emit('logout-all', user_id);
        return userDB.put(user);
      });
  };

  this.logoutSession = function(session_id) {
    var user;
    var startSessions = 0;
    var endSessions = 0;
    return userDB.query('auth/session', {key: session_id, include_docs: true})
      .then(function(results) {
        if(!results.rows.length) {
          return BPromise.reject({
            error: 'unauthorized',
            key: 'unauthorized',
            status: 401
          });
        }
        user = results.rows[0].doc;
        if(user.session) {
          startSessions = Object.keys(user.session).length;
          if(user.session[session_id]) {
            delete user.session[session_id];
          }
        }
        var promises = [];
        promises.push(session.deleteTokens(session_id));
        promises.push(dbAuth.removeKeys(session_id));
        if(user) {
          promises.push(dbAuth.deauthorizeUser(user, session_id));
        }
        return BPromise.all(promises);
      })
      .then(function() {
        // Clean out expired sessions
        return self.logoutUserSessions(user, 'expired');
      })
      .then(function(finalUser) {
        user = finalUser;
        if(user.session) {
          endSessions = Object.keys(user.session).length;
        }
        emitter.emit('logout', user._id);
        if(startSessions !== endSessions) {
          return userDB.put(user);
        } else {
          return BPromise.resolve(false);
        }
      });
  };

  this.logoutOthers = function(session_id) {
    var user;
    return userDB.query('auth/session', {key: session_id, include_docs: true})
      .then(function(results) {
        if(results.rows.length) {
          user = results.rows[0].doc;
          if(user.session && user.session[session_id]) {
            return self.logoutUserSessions(user, 'other', session_id);
          }
        }
        return BPromise.resolve();
      })
      .then(function(finalUser) {
        if(finalUser) {
          return userDB.put(finalUser);
        } else {
          return BPromise.resolve(false);
        }
      });
  };

  this.logoutUserSessions = function(userDoc, op, currentSession) {
    // When op is 'other' it will logout all sessions except for the specified 'currentSession'
    var promises = [];
    var sessions;
    if(op === 'all' || op === 'other') {
      sessions = util.getSessions(userDoc);
    } else if(op === 'expired') {
      sessions = util.getExpiredSessions(userDoc, Date.now());
    }
    if(op === 'other' && currentSession) {
      // Remove the current session from the list of sessions we are going to delete
      var index = sessions.indexOf(currentSession);
      if(index > -1) {
        sessions.splice(index, 1);
      }
    }
    if(sessions.length) {
      // Delete the sessions from our session store
      promises.push(session.deleteTokens(sessions));
      // Remove the keys from our couchDB auth database
      promises.push(dbAuth.removeKeys(sessions));
      // Deauthorize keys from each personal database
      promises.push(dbAuth.deauthorizeUser(userDoc, sessions));
      if(op === 'expired' || op === 'other') {
        sessions.forEach(function(session) {
          delete userDoc.session[session];
        });
      }
    }
    if(op ==='all') {
      delete userDoc.session;
    }
    return BPromise.all(promises)
      .then(function() {
        return BPromise.resolve(userDoc);
      });
  };

  this.remove = function(user_id, destroyDBs) {
    var user;
    var promises = [];
    return userDB.get(user_id)
      .then(function(userDoc) {
        return self.logoutUserSessions(userDoc, 'all');
      })
      .then(function(userDoc) {
        user = userDoc;
        if(destroyDBs !== true || !user.personalDBs) {
          return BPromise.resolve();
        }
        Object.keys(user.personalDBs).forEach(function(userdb) {
          if(user.personalDBs[userdb].type === 'private') {
            promises.push(dbAuth.removeDB(userdb));
          }
        });
        return BPromise.all(promises);
      })
      .then(function() {
        return userDB.remove(user);
      });
  };

  this.removeExpiredKeys = dbAuth.removeExpiredKeys;

  this.confirmSession = function(key, password) {
    return session.confirmToken(key, password);
  };

  this.quitRedis = function () {
    return session.quit();
  };

  function generateSession(username, roles) {
    var getKey;
    if(config.getItem('dbServer.cloudant')) {
      getKey = require('./dbauth/cloudant').getAPIKey(userDB);
    } else {
      var token = util.URLSafeUUID();
      // Make sure our token doesn't start with illegal characters
      while(token[0] === '_' || token[0] === '-') {
        token = util.URLSafeUUID();
      }
      getKey = BPromise.resolve({
        key: token,
        password: util.URLSafeUUID()
      });
    }
    return getKey
      .then(function(key) {
        var now = Date.now();
        return BPromise.resolve({
          _id: username,
          key: key.key,
          password: key.password,
          issued: now,
          expires: now + sessionLife * 1000,
          roles: roles
        });
      });
  }

  // Adds numbers to a base name until it finds a unique database key
  function generateUsername(base) {
    base = base.toLowerCase();
    var entries = [];
    var finalName;
    return userDB.allDocs({startkey: base, endkey: base + '\uffff', include_docs: false})
      .then(function(results){
        if(results.rows.length === 0) {
          return BPromise.resolve(base);
        }
        for(var i=0; i<results.rows.length; i++) {
          entries.push(results.rows[i].id);
        }
        if(entries.indexOf(base) === -1) {
          return BPromise.resolve(base);
        }
        var num = 0;
        while(!finalName) {
          num++;
          if(entries.indexOf(base+num) === -1) {
            finalName = base + num;
          }
        }
        return BPromise.resolve(finalName);
      });
  }

  function addUserDBs(newUser) {
    // Add personal DBs
    if(!config.getItem('userDBs.defaultDBs')) {
      return BPromise.resolve(newUser);
    }
    var promises = [];
    newUser.personalDBs = {};

    var processUserDBs = function(dbList, type) {
      dbList.forEach(function(userDBName) {
        var dbConfig = dbAuth.getDBConfig(userDBName);
        promises.push(
          dbAuth.addUserDB(newUser, userDBName, dbConfig.designDocs, type, dbConfig.permissions, dbConfig.adminRoles,
            dbConfig.memberRoles)
            .then(function(finalDBName) {
              delete dbConfig.permissions;
              delete dbConfig.adminRoles;
              delete dbConfig.memberRoles;
              delete dbConfig.designDocs;
              dbConfig.type = type;
              newUser.personalDBs[finalDBName] = dbConfig;
            }));
      });
    };

    // Just in case defaultDBs is not specified
    var defaultPrivateDBs = config.getItem('userDBs.defaultDBs.private');
    if(!Array.isArray(defaultPrivateDBs)) {
      defaultPrivateDBs = [];
    }
    processUserDBs(defaultPrivateDBs, 'private');
    var defaultSharedDBs = config.getItem('userDBs.defaultDBs.shared');
    if(!Array.isArray(defaultSharedDBs)) {
      defaultSharedDBs = [];
    }
    processUserDBs(defaultSharedDBs, 'shared');

    return BPromise.all(promises).then(function() {
      return BPromise.resolve(newUser);
    });
  }

  function isOnlyUsernameKey(checkKey, userDoc) {
    if (userDoc.providers instanceof Array && userDoc.providers.length >= 2)
      return false;

    for (var i = 0; i < usernameKeys.length; i++) {
      var key = usernameKeys[i];
      if (key != checkKey && userDoc[key]) {
        return false;
      }
    }

    return true;
  }

  return this;

};
