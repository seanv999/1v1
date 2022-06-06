let config = new Object({ fov:330, sensitivity:0.15, aimbot:true, esp:true, threshold:4.5 });


	const WebGL = WebGL2RenderingContext.prototype;
	HTMLCanvasElement.prototype.getContext = new Proxy( HTMLCanvasElement.prototype.getContext, {
		apply( target, thisArgs, args ){
			console.log('UGHHHH' + args[1])
			if (args[1]){

				args[1].preserveDrawingBuffer = true;
			}
			return Reflect.apply(...arguments);
		}
	});

	WebGL.shaderSource = new Proxy( WebGL.shaderSource, {
		apply( target, thisArgs, args ) {
			console.log('UGHHHH' + args[1])
			if ( args[ 1 ].indexOf( 'gl_Position' ) > - 1 ) {

				args[ 1 ] = args[ 1 ].replace( 'void main', `

					out float vDepth;
					uniform bool enabled;
					uniform float threshold;

					void main

				` ).replace( /return;/, `

					vDepth = gl_Position.z;

					if ( enabled && vDepth > threshold ) {

						gl_Position.z = 1.0;

					}

				` );

			} else if ( args[ 1 ].indexOf( 'SV_Target0' ) > - 1 ) {

				args[ 1 ] = args[ 1 ].replace( 'void main', `

					in float vDepth;
					uniform bool enabled;
					uniform float threshold;

					void main

				` ).replace( /return;/, `

					if ( enabled && vDepth > threshold ) {

						SV_Target0 = vec4( 1.0, 0.0, 0.0, 1.0 );

					}

				` );

			}

			return Reflect.apply( ...arguments );

		}
	} );

	WebGL.getUniformLocation = new Proxy( WebGL.getUniformLocation, {
		apply( target, thisArgs, [ program, name ] ) {
			
			const result = Reflect.apply( ...arguments );

			if ( result ) {

				result.name = name;
				result.program = program;

			}

			return result;

		}
	} );

	WebGL.uniform4fv = new Proxy( WebGL.uniform4fv, {
		apply( target, thisArgs, args ) {

			if ( args[ 0 ].name === 'hlslcc_mtx4x4unity_ObjectToWorld' ) {

				args[ 0 ].program.isUIProgram = true;

			}

			return Reflect.apply( ...arguments );

		}
	} );

	let movementX = 0, movementY = 0;
	let count = 0;

	WebGL.drawElements = new Proxy( WebGL.drawElements, {
		apply( target, thisArgs, args ) {

			const program = thisArgs.getParameter( thisArgs.CURRENT_PROGRAM );

			if ( ! program.uniforms ) {

				program.uniforms = {
					enabled: thisArgs.getUniformLocation( program, 'enabled' ),
					threshold: thisArgs.getUniformLocation( program, 'threshold' )
				};

			}

			const couldBePlayer = args[ 1 ] > 4000;

			thisArgs.uniform1i( program.uniforms.enabled, config.esp && couldBePlayer );
			thisArgs.uniform1f( program.uniforms.threshold, config.threshold );

			args[ 0 ] = false && ! program.isUIProgram && args[ 1 ] > 6 ? thisArgs.LINES : args[ 0 ];

			Reflect.apply( ...arguments );

			if ( config.aimbot && couldBePlayer ) {

				const width = Math.min( config.fov, thisArgs.canvas.width );
				const height = Math.min( config.fov, thisArgs.canvas.height );

				const pixels = new Uint8Array( width * height * 4 );

				const centerX = thisArgs.canvas.width / 2;
				const centerY = thisArgs.canvas.height / 2;

				const x = Math.floor( centerX - width / 2 );
				const y = Math.floor( centerY - height / 2 );

				thisArgs.readPixels( x, y, width, height, thisArgs.RGBA, thisArgs.UNSIGNED_BYTE, pixels );

				for ( let i = 0; i < pixels.length; i += 4 ) {

					if ( pixels[ i ] === 255 && pixels[ i + 1 ] === 0 && pixels[ i + 2 ] === 0 && pixels[ i + 3 ] === 255 ) {

						const idx = i / 4;

						const dx = idx % width;
						const dy = ( idx - dx ) / width;

						movementX += ( x + dx - centerX );
						movementY += - ( y + dy - centerY );

						count ++;

					}

				}

			}

		}
	} );

	window.requestAnimationFrame = new Proxy( window.requestAnimationFrame, {
		apply( target, thisArgs, args ) {

			args[ 0 ] = new Proxy( args[ 0 ], {
				apply() {

					const isPlaying = document.getElementById( '#canvas' ).style.cursor === 'none';

					if ( count > 0 && isPlaying ) {

						const f = config.sensitivity / count;

						movementX *= f;
						movementY *= f;

						window.dispatchEvent( new MouseEvent( 'mousemove', { movementX, movementY } ) );
					}

					movementX = 0;
					movementY = 0;
					count = 0;

					return Reflect.apply( ...arguments );

				}
			} );

			return Reflect.apply( ...arguments );

		}
	} )

	const fov = document.createElement('div');
	fov.id = 'FOV'
	window.addEventListener( 'DOMContentLoaded', function () {
		const credit = document.createElement('div')
		credit.innerText = `Developers \n Sean V \n Kevin D`
		credit.style.position = 'absolute'
		credit.style.top = '4%'
		credit.style.color = 'yellow'
		document.body.appendChild(credit)

		fov.style.position = 'absolute'
		fov.style.padding = 0;
		fov.style.margin = 0;
		fov.style.top = '50%'
		fov.style.left = '50%'
		fov.style.border = '5px solid yellow'
		fov.style.borderRadius = '50%';
		fov.style.height = `${config.fov}px`;
		fov.style.width = `${config.fov}px`;
		fov.style.transform = "translate(-50%,-50%)"
		document.body.appendChild(fov)
		var colors = ["red", "orange", "yellow", "green", "blue", "indigo", "violet"];

		var i = 1;

		// window.setInterval(function(){
		// 	fov.style.borderColor = colors[i];
		// 	credit.style.color = colors[i]
		// 	i++;
		// 	if (i === colors.length){
		// 		i=0;
		// 	}
		// }, 100);
	})

	document.onkeydown = function (event) {
		switch (event.keyCode) {

		case 38:
				config.fov += 10
				document.getElementById('FOV').style.height = `${config.fov}px`;
				document.getElementById('FOV').style.width = `${config.fov}px`;
			break;
		case 40:
				config.fov -= 10
				document.getElementById('FOV').style.height = `${config.fov}px`;
				document.getElementById('FOV').style.width = `${config.fov}px`;
			break;
		}
	};
	//RAPID FIRE
	const wasm = WebAssembly;
	const oldInstantiate = wasm.instantiate; //

	wasm.instantiate = async function(bufferSource, importObject) {
		const patcher = new WasmPatcher(bufferSource);

	
		patcher.aobPatchEntry({
			scan: '2A ? ? | 38 ? ? C 2 B 20 0',
			code: [
				OP.drop,
				OP.f32.const, VAR.f32(0)
			],
			onsuccess: () => {},
			onerror: e =>{
				alert('Failed patching Rapid Fire')
			}
		});


		const result = await oldInstantiate(patcher.patch(), importObject);

		return result;
	};

