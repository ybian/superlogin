'use strict';
var util = require('./util');
var LocalStrategy = require('passport-local');
var BearerStrategy = require('passport-http-bearer-sl').Strategy;


module.exports = function (config, passport, user) {

  // API token strategy
  passport.use(new BearerStrategy(
    function (tokenPass, done) {
      var parse = tokenPass.split(':');
      if(parse.length < 2) {
        done(null, false, {message: 'invalid token'});
      }
      var token = parse[0];
      var password = parse[1];
      user.confirmSession(token, password)
        .then(function (theuser) {
          done(null, theuser);
        }, function (err) {
          if (err instanceof Error) {
            done(err, false);
          } else {
            done(null, false, {message: err});
          }
        });
    }
  ));

  // Use local strategy
  passport.use(new LocalStrategy({
      usernameField: config.getItem('local.usernameField') || 'username',
      passwordField: config.getItem('local.passwordField') || 'password',
      session: false,
      passReqToCallback: true
    },
    function (req, username, password, done) {
      user.get(username)
        .then(function (theuser) {
          if (theuser) {
            // Check if the account is locked
            if(theuser.local && theuser.local.lockedUntil && theuser.local.lockedUntil > Date.now()) {
              if (!config.getItem('security.softLock')) {
                return done(null, false, {
                  error: 'Unauthorized',
                  key: 'soft_locked',
                  message: 'Your account is currently locked. Please wait a few minutes and try again.',
                  locked: true
                });
              } else if (!req.body.captchaPassed) {
                return done(null, false, {
                  error: 'Unauthorized',
                  key: 'missing_captcha',
                  message: 'Captcha is required to login.',
                  locked: true
                });
              }
            }
            if(!theuser.local || !theuser.local.derived_key) {
              return done(null, false, {
                error: 'Unauthorized',
                key: 'failed_login',
                message: 'Invalid username or password'
              });
            }
            util.verifyPassword(theuser.local, password)
              .then(function () {
                // Check if the email has been confirmed if it is required
                if(config.getItem('local.requireEmailConfirm') && !theuser.email) {
                  return done(null, false, {
                    error: 'Unauthorized',
                    key: 'email_unconfirmed',
                    message: 'You must confirm your email address.'
                  });
                }
                // Success!!!
                return done(null, theuser);
              }, function (err) {
                if (!err) {
                  // Password didn't authenticate
                  return handleFailedLogin(theuser, req, done);
                } else {
                  // Hashing function threw an error
                  return done(err);
                }
              });
          } else {
            // user not found
            return done(null, false, {
              error: 'Unauthorized',
              key: 'failed_login',
              message: 'Invalid username or password'
            });
          }
        }, function (err) {
          // Database threw an error
          return done(err);
        });
    }
  ));

  function handleFailedLogin(userDoc, req, done) {
    var invalid = {
      error: 'Unauthorized',
      key: 'failed_login',
      message: 'Invalid username or password',
    };
    return user.handleFailedLogin(userDoc, req)
      .then(function(locked) {
        invalid.locked = locked;
        if(locked) {
          invalid.key = 'locked';
          invalid.message = 'Maximum failed login attempts exceeded. Your account has been locked for ' +
              Math.round(config.getItem('security.lockoutTime') / 60) + ' minutes.';
        }
        return done(null, false, invalid);
      });
  }

};
