env.ARCH = 'arm'
env.BUILD = '0.1.' + env.BUILD_NUMBER
env.LATEST = 'latest'
env.DOCKER_REGISTRY = 'docker.steventaylor.me'
env.SERVICE_NAME = 'sentinel-liftmaster'
env.CONTAINER1 = env.SERVICE_NAME + '-' + env.ARCH
env.DOCKER_HOST = 'tcp://build-' + env.ARCH + '.steventaylor.me:2375'
env.CONSUL = 'consul.steventaylor.me'

env.USEKUBE = 0

node {

  withCredentials([[$class: 'UsernamePasswordMultiBinding', credentialsId: 'registry',
                    usernameVariable: 'dockeruser', passwordVariable: 'dockerpass']]) {
        stage 'build'
        checkout scm

        sh 'docker login -u ${dockeruser} -p ${dockerpass} ${DOCKER_REGISTRY}'
        sh 'docker build -t ${DOCKER_REGISTRY}/${CONTAINER1}:${LATEST} -t ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD} -f Dockerfile.${ARCH} .'

        stage 'push'
        sh 'docker push ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD}'
        sh 'docker push ${DOCKER_REGISTRY}/${CONTAINER1}:${LATEST}'

        stage 'cleanup'
        sh 'docker rmi ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD}'

        stage 'deploy'
        if ( env.USEKUBE == 1 ) {
            def r = sh ( script: 'kubectl get deployments/${SERVICE_NAME}', returnStatus: true )

            if (r == 0){
                // update the image
                sh 'kubectl set image deployment/${SERVICE_NAME} ${SERVICE_NAME}=${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD}'
            } else {
                // deploy service
                sh 'sed -e "s/\\:latest/:${BUILD}/; s/x86_64/${ARCH}/ ; s/consul\\.steventaylor\\.me/${CONSUL}/" ./kube.yml | kubectl create -f - --record'
            }
        } else {
            def r = sh ( script: 'docker service ps ${SERVICE_NAME}', returnStatus: true )

            if (r == 0){
                 sh 'docker service update --image  ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD} ${SERVICE_NAME}'
            } else {
                sh 'docker service create --name=${SERVICE_NAME} -e CONSUL=${CONSUL} --replicas=1 --network=sentinel ${DOCKER_REGISTRY}/${CONTAINER1}:${BUILD}'
            }
        }

    }
}
