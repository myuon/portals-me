# portals-me/api

[![CircleCI](https://circleci.com/gh/portals-me/api.svg?style=svg)](https://circleci.com/gh/portals-me/api)

## JWT

Server will generate the own jwt for authentication and authorization.

### Key Generation

```sh
$ cd token
$ ssh-keygen -t ecdsa -b 256 -f jwtES256.key
$ openssl ec -in jwtES256.key -pubout -outform PEM -out jwtES256.key.pub
```
