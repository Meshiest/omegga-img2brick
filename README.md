# img2brick plugin

An image-to-brick converter for [omegga](https://github.com/brickadia-community/omegga).

## Install

Easy: `omegga install gh:Meshiest/img2brick`

Manual:

* `git clone https://github.com/meshiest/omegga-img2brick img2brick` in `plugins` directory
* `npm i` in `img2brick` directory

## Screenshot

![](https://i.imgur.com/fchra47.png)

## Commands

Convert images to text under your player with the following commands:

Currently only supports PNGs and depends on experimental omegga

 * `!img url` - download an image and load it under your player
 * `!img:tile url` - the same as `!img` but with tiles instead of studs
 * `!img:micro url` - the same as `!img` but with microbricks instead of studs
