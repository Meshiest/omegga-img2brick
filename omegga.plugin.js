const fs = require('fs');
const request = require('request');
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const { PNG } = require('pngjs');

// path in which images are downloaded
const DOWNLOAD_FOLDER = path.join(__dirname, 'downloads');

// path to the heightmap binary
const HEIGHTMAP_BIN = path.join(__dirname, 'lib/heightmap');

module.exports = class Img2Brick {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
  }

  init() {
    this.omegga
      .on('chatcmd:img', async (name, ...args) => {
        const url = args.join(' ');
        this.convert(name, url);
      })
      .on('chatcmd:img:tile', async (name, ...args) => {
        const url = args.join(' ');
        this.convert(name, url, {tile: true});
      })
      .on('chatcmd:img:micro', async (name, ...args) => {
        const url = args.join(' ');
        this.convert(name, url, {micro: true});
      });

  }

  stop() {}

  async convert(name, url, {tile=false, micro=false}={}) {
    if (url.length < 3) return;

    // authorization check
    const isAuthorized = Omegga.getPlayer(name).isHost() || this.config['authorized'].split(',').includes(name);
    if (this.config['host-only'] && !isAuthorized) return;

    // check if player exists
    const player = this.omegga.getPlayer(name);
    if (!player) return;

    // cooldown check for unauthorized players
    if (!isAuthorized) {
      const now = Date.now();
      if ((await this.store.get('cooldown_' + player.id) || 0) + Math.max(this.config['cooldown'], 0) * 1000 > now) {
        return;
      }
      await this.store.set('cooldown_' + player.id, now);
    }

    // get player position
    const [offX, offY, offZ] = await player.getPosition();

    // file output settings
    const filename = name + '.png';
    const filepath = path.join(DOWNLOAD_FOLDER, filename);
    const savename = `img2brick_${name}`;
    const destpath = path.join(this.omegga.savePath, savename + '.brs');

    // download and run the heightmap
    try {
      console.info(name, 'DL =>', url);
      await this.downloadFile(url, filepath);
      const [width, height] = await this.checkPNG(filepath);
      console.info(name, 'OK =>', filename, `(${width} x ${height})`);
      await this.runHeightmap(filepath, destpath, {tile, micro, name, id: player.id});
      await this.omegga.loadBricks(savename, {
        offX: offX - width * 5,
        offY: offY - height * 5,
        offZ: offZ - 28,
      });
    } catch (e) {
      this.omegga.broadcast(`"error: ${e}"`);
      console.error(e);
    }
  }

  // download a png at a url to a file
  downloadFile(uri, filename) {
    return new Promise((resolve, reject) => {
      request.head(uri, (err, res) => {
        if (err) {
          return reject('could not make request');
        }

        // check content type
        if (res.headers['content-type'] !== 'image/png')
          return reject('wrong response format (expected image/png)');

        // check file size
        if (!(Number(res.headers['content-length']) < this.config['max-filesize']))
          return reject(`image file too large (${res.headers['content-length']} > ${this.config['max-filesize']})`);

        // go ahead and download the image.. we're really hoping they didn't lie in the content-type
        request(uri)
          .pipe(fs.createWriteStream(filename))
          .on('close', resolve);
      });
    });
  }

  // check if a png file has a valid size
  checkPNG(filename) {
    const maxSize = this.config['max-size'];
    return new Promise((resolve, reject) => {
      fs.createReadStream(filename)
        .pipe(new PNG())
        .on('error', () => reject('error parsing png'))
        .on('parsed', function () {
          if (this.width > maxSize || this.height > maxSize)
            return reject(`image dimensions too large (> ${maxSize})`);
          return resolve([this.width, this.height]);
        });
    });
  }

  // run the heightmap binary given an input file
  async runHeightmap(filename, destpath, {tile=false,micro=false,id,name}={}) {
    try {
      const command = HEIGHTMAP_BIN +
        ` -o ${destpath} --cull --owner_id "${id}" --owner "${name}" --img ${filename}${
          tile?' --tile':micro?' --micro':''
        }`;
      console.info(command);
      const { stdout } = await exec(command, {});
      console.log(stdout);
      const result = stdout.match(/Reduced (\d+) to (\d+) /);
      if (!stdout.match(/Done!/) || !result)
        throw 'could not finish conversion';

      // potentially check reduction size
      //const original = Number(result[1]);
      //const reduced = Number(result[2]);

      return true;
    } catch ({ cmd, stderr }) {
      console.error('command: ' + cmd);
      console.error(stderr);
      throw 'conversion software failed';
    }
  }

};
